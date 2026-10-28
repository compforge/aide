import { commitStatus } from "../status.ts";
import { separationCoolingDown } from "./config.ts";
import { retainRecent } from "../context.ts";
import { randomUUID } from "node:crypto";
import type { ResourceClient } from "@compforge/aide-plugin";
import { digest } from "../chief-model.ts";
import { TOPIC_TYPE, type TopicResource, type TopicSpec, type TopicStatus } from "../topic/model.ts";
import { understandingVersion, summaryVersion } from "../topic/tree.ts";
import { resourceRef } from "../input/state.ts";
import { GroupSchema, type WeaveResource } from "./model.ts";

/**
 * @spec Grouping changes only parent relationships. Existing Chief executions drain naturally; Input and Work ownership never moves.
 * @spec Version guards fence concurrent grouping and understanding changes, without freezing intake or waiting for Work.
 * @link docs/personal/topic.md
 * @case tests/weave.test.ts
 */
export async function groupTopics(resources: ResourceClient, weave: WeaveResource, raw: unknown, summaryChars: number) {
  const group = GroupSchema.parse(raw);
  if ((group.summary?.length ?? 0) > summaryChars) throw new Error("Condense the proposed summary");
  const refs = [...group.topics, ...(group.parent ? [group.parent] : [])];
  if (new Set(refs.map(t => t.uid)).size !== refs.length) throw new Error("Distinct roots required");
  const all = await resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE);
  const resolve = (ref: { uid: string; version: string }) => {
    const topic = all.find(t => t.metadata.uid === ref.uid);
    if (!topic || topic.metadata.deletionTimestamp || topic.spec.default || topic.spec.parentRef) throw new Error("Only available non-Default roots can be grouped");
    if (separationCoolingDown(topic))
      throw new Error("Topic organization is cooling down; respect the recorded boundary and retry later");
    if (understandingVersion(topic) !== ref.version) throw new Error("Topic understanding changed; read again");
    return topic;
  };
  const children = group.topics.map(resolve);
  let parent: TopicResource;
  if (group.parent) parent = resolve(group.parent);
  else {
    // The Resource API assigns UIDs on create. The new empty root is valid on its own;
    // all parent edges and synthesized understanding are then published in one commit.
    const id = randomUUID();
    parent = await resources.create(TOPIC_TYPE, { name: digest(id), spec: { id, name: group.name! },
      status: { receipts: [], summary: "", recent: [] } });
  }
  try {
    await commitStatus(resources, [
      ...children.map(resource => ({ operation: "replace" as const, resource, spec: { ...resource.spec, parentRef: resourceRef(parent) },
        status: { ...resource.status, nextTriggerAt: null, idleReviewCount: 0, organization: { at: new Date().toISOString(), actorUid: weave.metadata.uid,
          toUid: parent.metadata.uid, reason: `Weave grouped under ${parent.spec.name ?? parent.spec.id}` } } })),
      { operation: "patchStatus", resource: parent, patch: { organization: { at: new Date().toISOString(), actorUid: weave.metadata.uid, reason: "Weave combined related roots" }, weaveRevision: (parent.status.weaveRevision ?? 0) + 1,
        ...(!group.parent ? { summary: group.summary!, recent: retainRecent(children.flatMap(t => t.status.recent)),
          absorbed: Object.fromEntries(children.map(t => [t.metadata.uid, understandingVersion(t)])),
          absorbedSummaries: Object.fromEntries(children.map(t => [t.metadata.uid, summaryVersion(t)])) } : {}),
        lastInputAt: (group.parent ? [parent, ...children] : children).map(t => t.status.lastInputAt ?? t.metadata.creationTimestamp).sort().at(-1),
      } },
      { operation: "patchStatus", resource: weave, patch: {} },
    ]);
  } catch (error) {
    if (!group.parent) {
      try { await resources.delete(TOPIC_TYPE, parent.metadata.name, "v1", { uid: parent.metadata.uid, resourceVersion: parent.metadata.resourceVersion }); }
      catch (cleanup) { throw new AggregateError([error, cleanup], `Grouping failed; unused parent ${parent.metadata.uid} requires inspection`); }
    }
    throw error;
  }
  return { parentUid: parent.metadata.uid, childUids: children.map(t => t.metadata.uid), state: "grouped" };
}
