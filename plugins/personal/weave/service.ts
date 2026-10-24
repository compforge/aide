import { randomUUID } from "node:crypto";
import type { ResourceClient, ResourceCommit } from "@compforge/aide-plugin";
import { digest } from "../chief-model.ts";
import { TOPIC_TYPE, type TopicResource, type TopicSpec, type TopicStatus } from "../topic/model.ts";
import { understandingVersion } from "../topic/tree.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { resourceRef } from "../input/state.ts";
import { WORK_TYPES, type WorkResource } from "../resources.ts";
import { GroupSchema, type WeaveResource } from "./model.ts";

/** @spec Freeze intake before waiting for old executions. A durable plan survives process restarts.
 * @link docs/personal/topic.md
 * @case tests/weave.test.ts
 */
export async function planGroup(resources: ResourceClient, weave: WeaveResource, raw: unknown, summaryChars: number) {
  const group = GroupSchema.parse(raw);
  if (weave.status.plan) throw new Error("Weave already has a pending handoff");
  if (group.summary.length > summaryChars) throw new Error("Condense the proposed summary");
  if (new Set(group.topics.map(t => t.uid)).size !== group.topics.length) throw new Error("Distinct roots required");
  const all = await resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE);
  const roots = group.topics.map(ref => {
    const topic = all.find(t => t.metadata.uid === ref.uid);
    if (!topic || topic.metadata.deletionTimestamp || topic.spec.default || topic.spec.parentRef || topic.status.weaveLock) throw new Error("Only available non-Default roots can be grouped");
    if (understandingVersion(topic) !== ref.version) throw new Error("Topic understanding changed; read again");
    return topic;
  });
  const plan = { ...group, id: randomUUID(), at: new Date().toISOString() };
  await resources.commit([
    ...roots.map(resource => ({ operation: "patchStatus" as const, resource, patch: { weaveLock: plan.id } })),
    { operation: "patchStatus", resource: weave, patch: { plan } },
  ]);
  return { planId: plan.id, state: "waiting_for_quiescence" };
}

/** @spec Binding and completed receipts stay unchanged; only unstarted consumption and idle Work move.
 * Unknown effects block grouping instead of being replayed in a new native session.
 */
export async function applyGroup(resources: ResourceClient, weave: WeaveResource): Promise<"waiting" | "applied" | "stale"> {
  const plan = weave.status.plan;
  if (!plan) return "stale";
  const all = await resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE);
  const roots = plan.topics.map(ref => all.find(t => t.metadata.uid === ref.uid));
  if (roots.some(t => t?.status.execution)) return "waiting";
  const valid = roots.every((t, i) => t && !t.metadata.deletionTimestamp && !t.spec.parentRef && !t.spec.default
    && t.status.weaveLock === plan.id && understandingVersion(t) === plan.topics[i]!.version);
  const concrete = roots.filter((t): t is TopicResource => !!t);
  const pending = (await Promise.all(concrete.map(t => resources.list<InputSpec, InputStatus>(INPUT_TYPE,
    { matchIndex: { name: "assessPending", value: t.metadata.uid } })))).flat();
  const inputs = [...new Map(pending.map(i => [i.metadata.uid, i])).values()];
  const uncertain = inputs.some(i => concrete.some(t => {
    const a = i.status.assess?.[t.metadata.uid]; return a && !a.completedAt && a.executionId;
  }));
  if ((!valid || uncertain) && !plan.moving) {
    const staged = all.find(t => t.spec.id === plan.id);
    await resources.commit([
      ...concrete.filter(t => t.status.weaveLock === plan.id).map(resource => ({ operation: "patchStatus" as const, resource, patch: { weaveLock: null } })),
      ...(staged ? [{ operation: "delete" as const, resource: staged }] : []),
      { operation: "patchStatus", resource: weave, patch: { plan: null } },
    ]);
    return "stale";
  }
  if (!valid || uncertain) throw new Error("Moving Weave plan lost its frozen roots; inspect before continuing");
  const work = (await Promise.all(WORK_TYPES.map(type => resources.list<WorkResource["spec"], WorkResource["status"]>(type)))).flat()
    .filter(w => !w.metadata.deletionTimestamp && concrete.some(t => t.spec.id === w.spec.topicId));
  if (work.some(w => (w.status as import("../loop.ts").LoopStatus).execution)) return "waiting";
  // A staged parent stays hidden from routing and execution until the handoff commits.
  const name = digest(plan.id);
  let parent = all.find(t => t.spec.id === plan.id);
  if (!parent) parent = await resources.create(TOPIC_TYPE, { name, spec: { id: plan.id, name: plan.name },
    status: { receipts: [], summary: plan.summary, recent: [], weaveLock: plan.id } });
  const uid = parent.metadata.uid, parentRef = resourceRef(parent);
  const transfers: ResourceCommit[] = [
    ...inputs.map(resource => {
      const assess = { ...resource.status.assess };
      for (const t of concrete) if (assess[t.metadata.uid] && !assess[t.metadata.uid]!.completedAt) delete assess[t.metadata.uid];
      assess[uid] = { resource: parentRef, assignedAt: new Date().toISOString() };
      return { operation: "patchStatus" as const, resource, patch: { assess } };
    }),
    ...work.map(resource => ({ operation: "replace" as const, resource, spec: { ...resource.spec, topicId: parent!.spec.id }, status: resource.status })),
  ];
  const batchSize = 100 - concrete.length - 2;
  if (transfers.length > batchSize) {
    await resources.commit([
      ...concrete.map(resource => ({ operation: "patchStatus" as const, resource, patch: {} })),
      { operation: "patchStatus", resource: parent, patch: {} },
      ...transfers.slice(0, batchSize),
      { operation: "patchStatus", resource: weave, patch: { plan: { ...plan, moving: true } } },
    ]);
    return "waiting";
  }
  const writes: ResourceCommit[] = [
    ...concrete.map(resource => ({ operation: "replace" as const, resource, spec: { ...resource.spec, parentRef },
      status: { ...resource.status, weaveLock: null, nextTriggerAt: null } })),
    ...transfers,
    { operation: "patchStatus", resource: parent, patch: { weaveLock: null,
      absorbed: Object.fromEntries(concrete.map(t => [t.metadata.uid, understandingVersion(t)])),
      lastInputAt: concrete.map(t => t.status.lastInputAt ?? t.metadata.creationTimestamp).sort().at(-1) } },
    { operation: "patchStatus", resource: weave, patch: { plan: null } },
  ];
  await resources.commit(writes);
  return "applied";
}
