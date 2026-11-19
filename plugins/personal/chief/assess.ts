import { inputOutcome } from "./input-outcome.ts";
import { commitStatus } from "../status.ts";
import { agentCall } from "../observation/reference.ts";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { ResourceClient, ResourceCommit } from "@compforge/aide-plugin";
import { TOPIC_TYPE, type TopicResource, type TopicSpec, type TopicStatus } from "../topic/model.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { resourceRef, topicScope, belongsToTopic, type Input } from "../input/state.ts";
import { WorkInputRequestSchema, type WorkStatus } from "../work/model.ts";
import { WORK_TYPES, type WorkSpec } from "../work/resources.ts";
export const AssessInputSchema = z.object({ inputId: z.string().min(1), summary: z.string().min(1).max(1000),
  workRequests: z.array(z.object({ workUid: z.string().min(1), request: WorkInputRequestSchema }).strict()).max(100).default([]) }).strict();
export type AssessInput = z.input<typeof AssessInputSchema>;
/**
 * @spec Finishing Chief assessment and assigning Work handling are atomic; receipts remain on Input.
 * @spec Chief handling business Inputs may assess pending material in its Topic subtree, including Deferred; failed assessments remain terminal.
 * @spec Assessment does not update Topic summary/recent; meaningful understanding is maintained explicitly.
 * @link docs/personal/chief.md
 */
export async function assessInput(resources: ResourceClient, owner: Readonly<TopicResource>, executionId: string, raw: unknown, toolCallId?: string) {
  const args = AssessInputSchema.parse(raw);
  if (new Set(args.workRequests.map(r => r.workUid)).size !== args.workRequests.length) throw new Error("Duplicate Work request");
  for (let n = 0; ; n++) {
    const c = await resources.get<TopicSpec, TopicStatus>({ ...TOPIC_TYPE, ...owner.metadata });
    if (!c || c.metadata.uid !== owner.metadata.uid || c.metadata.deletionTimestamp || c.status.execution?.id !== executionId) throw new Error("Chief execution is no longer active");
    const input = await resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: args.inputId });
    if (!input) throw new Error("Input is unavailable");
    if (input.status.batchId) throw new Error(`This material belongs to input ${input.status.batchId}; assess the containing item`);
    const topics = await topicScope(resources, resourceRef(c));
    const topicUids = new Set(topics.map(t => t.metadata.uid));
    if (input.status.assess?.executionId !== executionId && !belongsToTopic(input, resourceRef(c), topicUids)) throw new Error("Input does not belong to this Topic subtree");
    if (input.status.assess?.lastError && !input.status.assess.retryable && !input.status.assess.completedAt) throw new Error("Input assessment has failed; submit a new Input");
    if (input.status.assess?.completedAt) return { assessed: args.inputId };
    if (input.status.assess?.executionId && input.status.assess.executionId !== executionId)
      throw new Error("Input is already admitted to another Chief execution");
    const at = new Date().toISOString();
    const { handle, guards } = await prepareWorkRequests(resources, input, topics, args.workRequests, at);
    const outcome = inputOutcome(input, c, at);
    try {
      await commitStatus(resources, [
        ...guards,
        { operation: "patchStatus", resource: input, patch: { handle, assess: { ...input.status.assess,
          lastError: undefined, errorAt: undefined, retryable: undefined,
          ...(toolCallId ? { completedBy: agentCall(c.status, toolCallId) } : {}), completedAt: at, result: { summary: args.summary, disposition: "completed" },
        } } },
        { operation: "patchStatus", resource: c, patch: outcome },
      ]);
      return { assessed: args.inputId, workUids: args.workRequests.map(r => r.workUid) };
    } catch (e) { if (n >= 8 || !/version conflict/.test(String(e))) throw e; }
  }
}

/** Work handling is independent of assessment receipt ownership. */
export async function prepareWorkRequests(resources: ResourceClient, input: Input, topics: readonly TopicResource[],
  requests: z.output<typeof AssessInputSchema>["workRequests"], at: string) {
  const work = requests.length ? (await Promise.all(topics.flatMap(topic => WORK_TYPES.map(type =>
    resources.list<WorkSpec, WorkStatus>(type, { matchIndex: { name: "topic", value: topic.metadata.uid } }))))).flat() : [];
  const handle = { ...input.status.handle };
  const guards: ResourceCommit[] = [];
  for (const { workUid, request } of requests) {
    const target = work.find(w => w.metadata.uid === workUid && topics.some(t => t.metadata.uid === w.status.topic.uid) && !w.metadata.deletionTimestamp);
    if (!target) throw new Error(`Work unavailable in this Topic: ${workUid}`);
    if (input.spec.origin === "source" && request.action !== "context") throw new Error("Source facts cannot be control requests");
    const previous = handle[workUid];
    if (previous && !isDeepStrictEqual(previous.request, request)) throw new Error("Input already has a different Work request; submit a new Input");
    handle[workUid] ??= { resource: resourceRef(target), assignedAt: at, request };
    guards.push({ operation: "patchStatus", resource: target, patch: { idleSince: null, agentStoppedAt: null } });
  }
  return { handle, guards };
}
