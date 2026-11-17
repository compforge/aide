import { BATCH_TYPE, type BatchSpec, type BatchStatus } from "../../batch/model.ts";
import { assessBatch, type AssessBatch } from "../../batch/assess.ts";
import { isGateTopic } from "../../topic/boundary.ts";
import type { MailSender } from "../../stream/sender.ts";
import { Addresses } from "../../address/service.ts";
import { addressTools } from "../../address/tools.ts";
import { readNote } from "../../note/service.ts";
import { WriterResourceSchema } from "../../note/model.ts";
import { topicTools } from "./topic-tools.ts";
import { inputPreview } from "../../input/prompt.ts";
import { Background as TopicBackground } from "./background.ts";
import type { PiConfig } from "../../../../src/host/harness/pi/config.ts";
import { summarizeTopic, upsertTopicNote } from "../../topic/state.ts";
import { say } from "../../output/action.ts";
import { assessInput, type AssessInput } from "../assess.ts";
import { resourceRef } from "../../input/state.ts";
import { immediate } from "../../execution/input.ts";
import type { ExecutionScope } from "../../../../src/protocol/verbs.ts";
import type { TopicSpec, TopicStatus } from "../../topic/model.ts";
import type { Logger } from "pino";
import type { Manager } from "../../../../src/host/plugin/manager.ts";
import { WorkService } from "../../work/service.ts";
import type { Store } from "../../work/store.ts";
import { TOPIC_TYPE } from "../../topic/model.ts";
import { domainHandoffTools } from "../../handoff/tools.ts";
import { Handoffs } from "../../handoff/service.ts";
import { BUSINESS_INPUT_ORIGINS } from "./input-tools.ts";
import { chiefTools } from "./chief-tools.ts";
import { createChiefAgent } from "./agent.ts";
import type { PiSessionFactory } from "../../../../src/host/harness/pi/adapter.ts";
import type { ConnectorClient } from "@compforge/aide-plugin";
import type { Persons } from "../../person/service.ts";

import { readLoopInput } from "../../execution/agent/read-input.ts";
import type { TopicPolicy } from "../../topic/config.ts";

/** Host binds the resource scope and capabilities; Runner only requests the Chief Harness. */
export function chiefSession(scope: ExecutionScope, config: PiConfig, dependencies: {
  store: Store; plugins: Manager; log: Logger; persons: Persons;
  connectors: ConnectorClient; mailSender: MailSender; policy: TopicPolicy;
}): PiSessionFactory {
  const { store, plugins, log, persons, connectors, mailSender, policy } = dependencies;
  const ref = scope.resourceRef;
  if (scope.pluginInstanceId !== "personal" || ref?.kind !== TOPIC_TYPE.kind || ref.apiVersion !== TOPIC_TYPE.apiVersion || !ref.uid) throw new Error("Chief requires a Topic resource scope");
  return async (options) => {
    const initial = store.resources.get<TopicSpec, TopicStatus>(TOPIC_TYPE, ref.name, ref.namespace);
    if (isGateTopic(initial) || initial.metadata.uid !== ref.uid || initial.metadata.deletionTimestamp) throw new Error("Chief Topic is missing or replaced");
    const topicId = initial.spec.id;
    const active = () => {
      const c = store.topics.resource(topicId);
      if (!c || c.metadata.uid !== initial.metadata.uid || !c.status.execution) throw new Error("Chief execution is not active");
      plugins.executionVerbs(c.status.execution.id, { topicId });
      return c;
    };
    const assess = async (input: AssessInput, toolCallId: string) => {
      const c = active();
      const result = await assessInput(plugins.resourceClient("personal"), c, c.status.execution!.id, input, toolCallId);
      log.info({ topicId, inputId: input.inputId, workUids: input.workRequests?.map(r => r.workUid) ?? [] }, "Chief assessment completed");
      return result;
    };
    const tools = chiefTools(connectors, async (id, input) => {
      const c = active();
      return say(plugins.executionVerbs(c.status.execution!.id, { topicId }), { ...input, idempotencyKey: id });
    }, (id, offset) => {
      const c = active();
      return readLoopInput(store, resourceRef(c), id, offset, true, policy.maxChars);
    }, assess, async input => {
      const c = active();
      const result = await summarizeTopic(plugins.resourceClient("personal"), c, c.status.execution!.id, input,
        policy.maxChars);
      log.info({ topicId, topicUid: input.topicUid ?? c.metadata.uid, summaryChanged: input.summary !== undefined, reviewedChildren: input.absorbed?.length ?? 0, version: result.version }, "Chief understanding updated");
      return result;
    }, notes => mailSender.cite(active().status.execution!.id, notes), async (args: AssessBatch, toolCallId: string) => {
      const c = active();
      const result = await assessBatch(plugins.resourceClient("personal"), c, c.status.execution!.id, args, toolCallId);
      log.info({ topicId, batchId: args.batchId, executionId: c.status.execution!.id }, "Chief Batch assessed");
      return result;
    });
    return createChiefAgent({ ...options, scope: `chief:${initial.metadata.uid}`, config, inputBinding: {
      read: () => {
        const c = active();
        return { executionId: c.status.execution!.id, origin: c.status.execution!.inputOrigin ?? "aide:review",
          inputs: [...store.topics.inputStore.query("assessExecution", c.status.execution!.id).map(i => ({
            id: i.metadata.name, deliveryId: i.status.assess?.deliveryId ?? `input:${i.metadata.uid}`, initial: !i.status.assess?.deliveryId && i.status.assess?.startedAt === c.status.execution!.startedAt,
            origin: i.spec.origin, immediate: immediate(i.spec), text: inputPreview(i, Math.floor(policy.contextChars / 8)),
          })), ...store.resources.list<BatchSpec, BatchStatus>(BATCH_TYPE, { matchIndex: { name: "execution", value: c.status.execution!.id } }).flatMap(batch =>
            store.topics.inputStore.query("batch", batch.metadata.uid).map(i => ({ id: i.metadata.name, batchId: batch.metadata.uid,
              deliveryId: batch.status.assess?.deliveryId ?? `batch:${batch.metadata.uid}`, initial: !batch.status.assess?.deliveryId && batch.status.assess?.startedAt === c.status.execution!.startedAt,
              origin: i.spec.origin, immediate: false, text: inputPreview(i, Math.floor(policy.contextChars / 8)) }))) ] };
      },
      inputOrigin: id => store.topics.inputStore.get(id)?.spec.origin,
      changed: (task, tools) => log.info({ topicId, executionId: task.executionId, inputOrigin: task.origin,
        inputIds: task.inputs.map(i => i.id), tools, toolCount: tools.length }, "Chief Input tools selected"),
    }, work: new WorkService(store, topicId, log), persons: persons, tools: [...tools, ...domainHandoffTools(new Handoffs(store, log), active).map(t => ({ ...t, inputOrigins: BUSINESS_INPUT_ORIGINS })), ...addressTools(new Addresses(store.resources.storage.home), active, ref => store.topics.outputStore.deliveryCapability(ref)), ...topicTools(store, active, log)], background: () => new TopicBackground(store, active(), topicId), readNote: id => readNote(plugins.resourceClient("personal"), id), topicNote: async (input, callId) => {
      const c = active();
      const result = await upsertTopicNote(plugins.resourceClient("personal"), c, c.status.execution!.id, input, callId, policy.maxChars);
      log.info({ topicId, targetTopicId: input.topicId, noteId: result.noteId, version: result.version, sensitivity: result.sensitivity, visibility: result.visibility }, "Topic Note updated");
      return result;
    }, contextWriter: () => { const c = active(); return { resource: WriterResourceSchema.parse(resourceRef(c)), executionId: c.status.execution!.id }; }, beforeWorkMutation: () => { active(); } });
  };
}
