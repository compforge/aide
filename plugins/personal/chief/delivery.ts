import type { Logger } from "pino";
import { deliveredMessageId } from "../../../agents/pi/input.ts";
import type { ReadSession } from "../observation/session.ts";
import type { Input as SessionInput } from "@compforge/agent-observation";
import type { ResourceClient, ResourceCommit } from "@compforge/aide-plugin";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { BATCH_TYPE, type BatchSpec, type BatchStatus } from "../batch/model.ts";
import { deliveryFinished, INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { resourceRef } from "../input/state.ts";
import { SummaryOwnerSchema } from "../input/review.ts";
import type { ResourceContext } from "../context.ts";
import type { TopicResource, TopicStatus } from "../topic/model.ts";
import { commitStatus } from "../status.ts";
import { inputOutcome } from "./input-outcome.ts";
import { completeChiefWork } from "./workload.ts";

/** Commit all items carried by the same provider request before the model can produce side effects. */
export async function recordDelivery(resources: ResourceClient, owner: TopicResource, executionId: string, deliveryId: string) {
  for (let attempt = 0; ; attempt++) {
    const topic = await resources.get<TopicResource["spec"], TopicStatus>(resourceRef(owner));
    if (topic?.status.execution?.id !== executionId) throw new Error("Chief execution is no longer active");
    const matchIndex = { name: "deliveryExecution", value: executionId };
    const [inputs, batches] = await Promise.all([
      resources.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex }),
      resources.list<BatchSpec, BatchStatus>(BATCH_TYPE, { matchIndex }),
    ]);
    const at = new Date().toISOString();
    const writes: ResourceCommit[] = [];
    const status = { ...topic.status };
    for (const item of [...inputs, ...batches]) {
      const receipt = item.status.assess;
      if (!receipt || deliveryFinished(receipt) || (receipt.deliveryId ?? executionId) !== deliveryId) continue;
      const assess = { ...receipt, completedAt: at, lastError: undefined, errorAt: undefined, retryable: undefined };
      if (item.kind === "Batch") {
        writes.push({ operation: "patchStatus", resource: item, patch: { phase: "completed", assess } });
        status.chiefWorkload = completeChiefWork({ ...topic, status }, at);
      } else {
        const input = item as typeof inputs[number];
        writes.push({ operation: "patchStatus", resource: input, patch: { assess } });
        Object.assign(status, inputOutcome(input, { ...topic, status }, at));
        if (input.spec.origin === "aide:summary") {
          const ref = SummaryOwnerSchema.parse(input.spec.observation?.summaryOwner);
          const subject = await resources.get<unknown, ResourceContext>(ref);
          if (subject?.metadata.uid === ref.uid && !subject.metadata.deletionTimestamp) {
            if (ref.uid === topic.metadata.uid) status.summaryReviewedAt = at;
            else writes.push({ operation: "patchStatus", resource: subject, patch: { summaryReviewedAt: at } });
          }
        }
      }
    }
    if (!writes.length) return false;
    try {
      await commitStatus(resources, [...writes, { operation: "patchStatus", resource: topic, patch: status }]);
      return true;
    } catch (error) { if (attempt >= 8 || !/version conflict/.test(String(error))) throw error; }
  }
}

/** @spec A queued message becomes delivered only when its admission marker enters the request context.
 * @link docs/personal/input.md
 */
export function bindInputDelivery(session: AgentSession, owner: () => TopicResource, resources: ResourceClient, log: Logger) {
  session.agent.subscribe(async event => {
    if (event.type !== "message_end" || event.message.role !== "user") return;
    const id = deliveredMessageId(event.message.content);
    if (!id) return;
    const topic = owner();
    const executionId = topic.status.execution!.id;
    if ((id === executionId || id.startsWith(executionId + ":")) && await recordDelivery(resources, topic, executionId, id))
      log.info({ topicUid: topic.metadata.uid, executionId, deliveryId: id }, "Input delivered to Chief context");
  });
}

/** Reconcile the crash window between Pi persisting the user message and Personal committing delivery. */
export async function recoverInputDeliveries(resources: ResourceClient, topic: TopicResource, readSession: ReadSession) {
  const execution = topic.status.execution;
  if (!execution) return;
  const matchIndex = { name: "deliveryExecution", value: execution.id };
  const [inputs, batches] = await Promise.all([
    resources.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex }),
    resources.list<BatchSpec, BatchStatus>(BATCH_TYPE, { matchIndex }),
  ]);
  const sessions = new Map<string, { agent: Parameters<ReadSession>[0]; messages: Set<string> }>();
  for (const item of [...inputs, ...batches]) {
    const receipt = item.status.assess;
    const sessionId = receipt?.agent?.sessionId;
    if (!receipt?.agent || !sessionId || deliveryFinished(receipt)) continue;
    const pending = sessions.get(sessionId) ?? { agent: { ...receipt.agent, sessionId }, messages: new Set<string>() };
    pending.messages.add(receipt.deliveryId ?? execution.id);
    sessions.set(sessionId, pending);
  }
  for (const { agent, messages } of sessions.values()) {
    const view = await readSession(agent);
    for (const node of view.nodes.filter((n): n is SessionInput => n.kind === "input")) {
      if (!node.started_at || node.started_at < execution.startedAt || !node.content || typeof node.content !== "object" || Array.isArray(node.content)) continue;
      const id = deliveredMessageId(node.content.content);
      if (id && messages.delete(id)) await recordDelivery(resources, topic, execution.id, id);
    }
  }
}
