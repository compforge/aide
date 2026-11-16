import { isDeepStrictEqual } from "node:util";
import type { PluginContext, ResourceClient, ResourceValidationContext } from "@compforge/aide-plugin";
import { INPUT_TYPE, InputAttention, assessmentFinished, inputAttention, isInternalInput, type InputSpec, type InputStatus } from "./model.ts";
import { inputRef, resourceRef, type Input } from "./state.ts";
import { inputExpired } from "./retention.ts";
import { commitStatus } from "../status.ts";
import { digest } from "../chief-model.ts";
import { readTopicRoot } from "../topic/tree.ts";
import { requireTopic } from "../topic/ownership.ts";
import { isProcessingRoot } from "../topic/boundary.ts";
import type { TopicResource } from "../topic/model.ts";
import type { TopicPolicy } from "../topic/config.ts";

function sameScope(batch: Input, member: Input): boolean {
  return batchKey({ ...batch, spec: { ...batch.spec, attention: inputAttention(member.spec) }, status: { ...batch.status, topic: member.status.topic } }) === batchKey(member)
    && inputAttention(batch.spec) === (inputAttention(member.spec) === InputAttention.Immediate ? InputAttention.Immediate : InputAttention.Normal);
}

/** Batch compatibility preserves source, identity and authority; origin alone is insufficient. */
export function batchKey(input: Input): string {
  const s = input.spec;
  return JSON.stringify([s.origin, s.originId, inputAttention(s), input.status.topic?.uid, s.source, s.sender,
    s.originRef, s.relation, s.sensitivity, s.visibility, s.timezone, s.handoff]);
}
function unclaimed(input: Input) { return !input.metadata.deletionTimestamp && !inputExpired(input)
  && !!input.status.assess && !assessmentFinished(input.status.assess) && !input.status.assess.executionId; }

/** @spec Batch creation and member delegation commit atomically; validation runs before member writes.
 * @case tests/input-batch.test.ts
 * @link docs/personal/input.md#secretary-聚合与提级
 */
export function validateBatch(input: Input, context: ResourceValidationContext) {
  if (!input.spec.batch) return;
  if (isInternalInput(input.spec) || input.spec.handoff || input.spec.attention === InputAttention.Deferred) throw new Error("Invalid batch scope");
  const members = input.spec.batch.members.map(ref => context.get<InputSpec, InputStatus>(INPUT_TYPE, ref.uid));
  if (new Set(input.spec.batch.members.map(m => m.uid)).size !== members.length) throw new Error("Duplicate batch member");
  const first = members[0];
  if (!first || members.some((m, n) => !m || m.metadata.name !== input.spec.batch!.members[n]!.name || m.status.batch || m.spec.batch || !unclaimed(m)
    || batchKey(m) !== batchKey(first) || m.status.assess?.topic?.uid !== input.status.assess?.topic?.uid)) throw new Error("Batch members changed; prepare again");
  if (input.spec.batch.oldestAt !== members.map(m => m!.metadata.creationTimestamp).sort()[0]) throw new Error("Batch must retain oldest arrival");
  if (!sameScope(input, first)) throw new Error("Batch changes origin or attention");
  for (const member of members) {
    let topic = requireTopic(member!.status.topic, context);
    const seen = new Set<string>();
    while (!isProcessingRoot(topic) && topic.spec.parentRef) {
      if (seen.has(topic.metadata.uid)) throw new Error("Topic parent cycle");
      seen.add(topic.metadata.uid); topic = requireTopic(topic.spec.parentRef, context);
    }
    if (topic.metadata.uid !== input.status.assess?.topic?.uid) throw new Error("Batch processing assignment changed");
  }
}
export function validateBatchUpdate(previous: Input, current: Input, context: ResourceValidationContext) {
  if (!isDeepStrictEqual(previous.status.batch, current.status.batch)) {
    if (previous.status.assess?.executionId || assessmentFinished(previous.status.assess)) throw new Error("Claimed Input cannot change batch");
    if (current.status.batch) {
      const batch = context.get<InputSpec, InputStatus>(INPUT_TYPE, current.status.batch.uid);
      if (!batch?.spec.batch?.members.some(m => m.uid === current.metadata.uid) || !unclaimed(batch)) throw new Error("Input batch is unavailable");
    } else if (previous.status.batch) {
      const batch = context.get<InputSpec, InputStatus>(INPUT_TYPE, previous.status.batch.uid);
      if (batch && !batch.metadata.deletionTimestamp && !assessmentFinished(batch.status.assess)) throw new Error("Cancel batch before releasing members");
    }
  }
  if (current.status.batch && (previous.status.assess?.executionId !== current.status.assess?.executionId
    || previous.status.assess?.completedAt !== current.status.assess?.completedAt)) {
    const batch = context.get<InputSpec, InputStatus>(INPUT_TYPE, current.status.batch.uid);
    if (current.status.assess?.executionId && (batch?.status.assess?.executionId !== current.status.assess.executionId
      || (!previous.status.assess?.executionId && !sameScope(batch, current))))
      throw new Error("Batch member requires its batch execution");
    if (current.status.assess?.completedAt && !current.status.assess.executionId) throw new Error("Batch member must be admitted before assessment");
  }
}

/** Expand only at the execution boundary. Queue selection and preparation operate on the envelope. */
export async function expandInputs(resources: ResourceClient, inputs: readonly Input[]): Promise<Input[]> {
  const result: Input[] = [];
  for (const input of inputs) {
    result.push(input);
    for (const ref of input.spec.batch?.members ?? []) {
      const member = await resources.get<InputSpec, InputStatus>(ref);
      if (!member || member.metadata.deletionTimestamp || inputExpired(member) || member.status.batch?.uid !== input.metadata.uid
        || !unclaimed(member) || !sameScope(input, member) || member.status.assess?.topic?.uid !== input.status.assess?.topic?.uid) throw new Error(`Batch member unavailable: ${ref.name}`);
      result.push(member);
    }
  }
  return result;
}

/** @spec A failed or missing member never becomes a successful aggregate receipt. */
export async function settleBatch(resources: ResourceClient, batch: Input) {
  if (!batch.spec.batch || assessmentFinished(batch.status.assess)) return;
  const members = await Promise.all(batch.spec.batch.members.map(ref => resources.get<InputSpec, InputStatus>(ref)));
  if (members.every(m => m && !m.metadata.deletionTimestamp && !inputExpired(m) && !assessmentFinished(m.status.assess))) return;
  const missing = members.some(m => !m || m.metadata.deletionTimestamp || inputExpired(m));
  if (!missing && members.some(m => !assessmentFinished(m!.status.assess))) return;
  const success = !missing && members.every(m => m!.status.assess?.completedAt);
  const at = new Date().toISOString();
  await commitStatus(resources, [{ operation: "patchStatus", resource: batch, patch: { assess: { ...batch.status.assess,
    ...(success ? { completedAt: at, result: { summary: `All ${members.length} batch members assessed`, disposition: "completed" as const } }
      : { lastError: missing ? "Batch material missing or expired; inspect member evidence" : "Batch contains failed assessments", errorAt: at }) } } }]);
}

/** Secretary checks batches before admission; regrouping releases only unclaimed members. */
export async function reconcileBatches(context: Pick<PluginContext, "resources" | "logger">, topic: TopicResource) {
  const page = await context.resources.page<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: "batchOpen", value: topic.metadata.uid }, limit: 40 });
  for (const batch of page.items) {
    if (batch.status.assess?.executionId) { await settleBatch(context.resources, batch); continue; }
    const members = await Promise.all(batch.spec.batch!.members.map(ref => context.resources.get<InputSpec, InputStatus>(ref)));
    const roots = await Promise.all(members.map(m => m?.status.topic ? readTopicRoot(context.resources, m.status.topic) : undefined));
    if (members.every((m, n) => m && unclaimed(m) && m.status.batch?.uid === batch.metadata.uid && sameScope(batch, m) && m.status.assess?.topic?.uid === topic.metadata.uid && roots[n]?.metadata.uid === topic.metadata.uid)) continue;
    const at = new Date().toISOString();
    await commitStatus(context.resources, [
      { operation: "patchStatus", resource: batch, patch: { assess: { ...batch.status.assess, completedAt: at,
        result: { summary: "Batch membership or ownership changed before admission", disposition: "cancelled" } } } },
      ...members.filter((m): m is Input => !!m && !m.metadata.deletionTimestamp && !m.status.assess?.executionId && !assessmentFinished(m.status.assess))
        .map(m => ({ operation: "patchStatus" as const, resource: m, patch: { batch: undefined, assess: { ...m.status.assess, topic: undefined } } })),
    ]);
    context.logger.info("Secretary batch cancelled before admission", { attributes: { inputId: batch.metadata.name, topicUid: topic.metadata.uid } });
  }
}

/** @spec All unclaimed origins participate in count/age promotion; Immediate never gains authority and only Deferred gains Normal attention.
 * @spec Packing preserves oldest arrival and does not depend on an idle Chief.
 * @case tests/input-batch.test.ts
 */
export async function prepareInputs(context: Pick<PluginContext, "resources" | "logger">, topic: TopicResource, policy: TopicPolicy, now = Date.now()) {
  await reconcileBatches(context, topic);
  const groups = new Map<string, Input[]>();
  const page = await context.resources.page<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: "secretaryPending", value: topic.metadata.uid }, limit: 100 });
  let next = policy.trigger.intervalSeconds * 1000;
  for (const input of page.items) {
    if (!unclaimed(input)) continue;
    const key = batchKey(input), group = groups.get(key) ?? [];
    group.push(input); groups.set(key, group);
  }
  for (const group of groups.values()) {
    const first = group[0]!, rule = inputAttention(first.spec) === InputAttention.Deferred ? policy.deferred : policy.secretary;
    const due = Date.parse(first.metadata.creationTimestamp) + rule.maxWaitSeconds * 1000;
    if (group.length < rule.count && due > now) { next = Math.min(next, due - now); continue; }
    const members = group.slice(0, 10), at = new Date(now).toISOString();
    if (isInternalInput(first.spec) || first.spec.handoff || (members.length === 1 && inputAttention(first.spec) !== InputAttention.Deferred)) {
      await commitStatus(context.resources, members.map(input => ({ operation: "patchStatus" as const, resource: input, patch: { promotedAt: at } })));
      context.logger.info("Secretary Inputs promoted", { attributes: { topicUid: topic.metadata.uid, inputIds: members.map(m => m.metadata.name), reason: group.length >= rule.count ? "count" : "age" } });
      continue;
    }
    const name = `batch-${digest([topic.metadata.uid, members.map(m => [m.metadata.uid, m.metadata.resourceVersion])])}`;
    const spec: InputSpec = { ...first.spec, inputKey: undefined, topicKey: undefined,
      topicId: topic.spec.id, attention: inputAttention(first.spec) === InputAttention.Immediate ? InputAttention.Immediate : InputAttention.Normal,
      batch: { members: members.map(resourceRef), oldestAt: first.metadata.creationTimestamp },
      text: `Process these original Inputs independently: ${members.map(m => m.metadata.name).join(", ")}. Read each member for full evidence and assess each member; do not assess this scheduling envelope.`, observation: undefined };
    const writes = [{ operation: "create" as const, type: INPUT_TYPE, name, spec, status: { topic: resourceRef(topic), promotedAt: at,
      route: { completedAt: at, result: { topics: [resourceRef(topic)], reason: "Secretary batch preparation" } }, assess: { topic: resourceRef(topic) } } }];
    // Personal Input admission assigns a stable input:<name> UID in this same transaction.
    const uid = `input:${name}`;
    try {
      await commitStatus(context.resources, [...writes, ...members.map(member => ({ operation: "patchStatus" as const, resource: member,
        patch: { batch: { ...inputRef(name), uid } } }))]);
    } catch (error) {
      if (!String(error).includes("Resource capacity exhausted")) throw error;
      // At full quota, release scheduling pressure without allocating another resource or losing evidence.
      await commitStatus(context.resources, members.map(input => ({ operation: "patchStatus" as const, resource: input, patch: { promotedAt: at } })));
      context.logger.warn("Secretary promoted originals at Input capacity", { attributes: { topicUid: topic.metadata.uid, inputIds: members.map(m => m.metadata.name) } });
      continue;
    }
    context.logger.info("Secretary batch prepared", { attributes: { topicUid: topic.metadata.uid, inputId: name, count: members.length,
      oldestAt: first.metadata.creationTimestamp, reason: group.length >= rule.count ? "count" : "age" } });
  }
  return Math.max(1, next);
}
