import { noteDirectory } from "../../note/directory.ts";
import { isGateTopic } from "../../topic/boundary.ts";
import { gateReadTools } from "../../gate/read-tools.ts";
import { domainHandoffTools } from "../../handoff/tools.ts";
import { Handoffs } from "../../handoff/service.ts";
import { Addresses } from "../../address/service.ts";
import { addressReadTools } from "../../address/tools.ts";
import { summaryText, summaryReference } from "../../note/summary.ts";
import { contentVersion } from "../../context-write.ts";
import { workContextTools } from "../../work/context.ts";
import { sayTool } from "../../output/tool.ts";
import { identityBackground } from "../../execution/agent/identity.ts";
import type { Persons } from "../../person/service.ts";
import { contextPage, relatedWork } from "../../background.ts";
import { Background } from "../background.ts";
import type { Logger } from "pino";
import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiConfig } from "../../../../src/host/harness/pi/config.ts";
import type { PiSessionFactory } from "../../../../src/host/harness/pi/adapter.ts";
import type { ExecutionScope } from "../../../../src/protocol/verbs.ts";
import type { Manager } from "../../../../src/host/plugin/manager.ts";
import type { Store } from "../../work/store.ts";
import { createTaskAgent } from "./agent.ts";
import { reportWorkTool } from "../../work/agent/report.ts";
import { TASK_TYPE, type TaskSpec, type TaskStatus } from "../model.ts";
import { inputPrinter } from "../../input/printer.ts";
import { say } from "../../output/action.ts";
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
const tool = <T extends TSchema>(definition: ToolDefinition<T>): ToolDefinition<T> => definition;
/** Host binds scope; the model never supplies Task or Topic identity. */
export function taskSession(scope: ExecutionScope, config: PiConfig, store: Store, plugins: Manager, log: Logger, persons?: Persons): PiSessionFactory {
  const ref = scope.resourceRef;
  if (scope.pluginInstanceId !== "personal" || ref?.kind !== TASK_TYPE.kind || ref.apiVersion !== TASK_TYPE.apiVersion || !ref.uid) throw new Error("Task requires its owning resource scope");
  return async options => {
    const current = () => {
      const task = store.resources.get<TaskSpec, TaskStatus>(TASK_TYPE, ref.name, ref.namespace);
      if (task.metadata.uid !== ref.uid || task.metadata.deletionTimestamp || !task.status.execution) throw new Error("Task execution is no longer active");
      plugins.executionVerbs(task.status.execution.id, { topicId: store.topicId(task.status.topic), taskId: task.metadata.name });
      return task;
    };
    const verbs = () => { const task = current(); return plugins.executionVerbs(task.status.execution!.id, { topicId: store.topicId(task.status.topic), taskId: task.metadata.name }); };
    const tools: ToolDefinition[] = [
      ...addressReadTools(new Addresses(store.resources.storage.home), current, ref => store.topics.outputStore.deliveryCapability(ref)),
      ...workContextTools("task", plugins.resourceClient("personal"), current, log),
      tool({ name: "list_work", label: "List related work", description: "Page through this Topic's Task, Routine and Ongoing summaries; does not delegate or resume work.",
        parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
        async execute(_id, { offset = 0 }) { return result(contextPage(relatedWork(store, store.topicId(current().status.topic)), offset)); } }),
      tool({ name: "read_task", label: "Read task", description: "Read this Task's objective, state, latest handling report, long-lived summary and Note directory. Use read_note for complete bodies.", parameters: Type.Object({}),
        async execute() { const r = current(); return result({ ...r, summaryText: summaryText(store.resources, r), summaryNote: summaryReference(store.resources, r), version: contentVersion(r), notes: noteDirectory(store.resources.storage, r.metadata.uid) }); } }),
      tool({ name: "read_topic", label: "Read topic", description: "Read the owning Topic as context, not additional authority.", parameters: Type.Object({}),
        async execute() { const c = store.topics.resource(store.topicId(current().status.topic)); return result(c ? { ...c.spec, summary: summaryText(store.resources, c), summaryUid: summaryReference(store.resources, c)?.uid, summaryNote: summaryReference(store.resources, c), notes: noteDirectory(store.resources.storage, c.metadata.uid) } : null); } }),
      tool({ name: "read_input", label: "Read input", description: "List pending assigned inputs, or page through one assigned input. Failed attempts need effect inspection.",
        parameters: Type.Object({ inputId: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
        async execute(_id, { inputId, offset = 0 }) {
          const task = current(), storeInputs = store.topics.inputStore;
          if (!inputId) { const all = storeInputs.query("handlePending", task.metadata.uid); return result({ inputs: all.slice(offset, offset + 20).map(i => ({ inputId: i.metadata.name, handling: i.status.handle![task.metadata.uid] })), nextOffset: offset + 20 < all.length ? offset + 20 : null }); }
          const input = storeInputs.get(inputId);
          if (!input?.status.handle?.[task.metadata.uid]) throw new Error("Input is not assigned to this Task");
          const text = inputPrinter.describe(input);
          return result({ inputId, handling: input.status.handle[task.metadata.uid], text: text.slice(offset, offset + 8000), nextOffset: offset + 8000 < text.length ? offset + 8000 : null });
        } }),
      sayTool((id, input) => say(verbs(), { ...input, idempotencyKey: id })),
      reportWorkTool(plugins.resourceClient("personal"), current, log),
    ];
    // @tmp Existing Gate Work retains its admitted read scope; guardWork rejects every new Gate Work.
    if (isGateTopic(store.topics.byRef(current().status.topic))) {
      const reads = gateReadTools(store, current), names = new Set(reads.map(t => t.name));
      tools.splice(0, tools.length, ...tools.filter(t => !names.has(t.name)), ...reads);
    }
    tools.push(...domainHandoffTools(new Handoffs(store, log), current));
    return createTaskAgent({ ...options, config, scope: `task:${ref.uid}`, tools, background: identityBackground(persons, () => {
      const background = new Background(store, current());
      return { text: () => background.text() };
    }) });
  };
}
