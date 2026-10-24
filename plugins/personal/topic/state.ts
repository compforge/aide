import { resourceRef } from "../input/state.ts";
import { topicSubtree, understandingVersion } from "./tree.ts";
import { z } from "zod";
import { SUMMARY_CHARS, RECENT_CHARS } from "../context.ts";
import type { ResourceClient } from "@compforge/aide-plugin";
import { TOPIC_TYPE, type TopicResource, type TopicSpec, type TopicStatus } from "./model.ts";

/** @spec A stale execution cannot mutate a replacement Topic. */
export async function updateTopic(resources: ResourceClient, ref: Readonly<TopicResource>,
  change: (current: Readonly<TopicResource>) => Partial<TopicStatus>): Promise<Readonly<TopicResource>> {
  for (let attempt = 0; ; attempt++) {
    const current = await resources.get<TopicSpec, TopicStatus>({ ...TOPIC_TYPE, ...ref.metadata });
    if (!current || current.metadata.uid !== ref.metadata.uid || current.metadata.deletionTimestamp) throw new Error("Topic no longer exists");
    const patch = change(current);
    if (!Object.keys(patch).length) return current;
    try { return await resources.patchStatus(current, patch); }
    catch (error) { if (attempt >= 8 || !/version conflict/.test(String(error))) throw error; }
  }
}

export const TopicContextSchema = z.object({ topicUid: z.string().optional(), absorbed: z.array(z.object({ uid: z.string(), version: z.string() }).strict()).max(20).optional(), version: z.string(), summary: z.string().max(SUMMARY_CHARS), recent: z.string().min(1).max(RECENT_CHARS).optional() }).strict();
export type TopicContextUpdate = z.infer<typeof TopicContextSchema>;

/** @spec Meaningful synthesis updates understanding independently of Input receipts; recent evidence is optional. Stale synthesis must be merged again. */
export async function summarizeTopic(resources: ResourceClient, owner: Readonly<TopicResource>, executionId: string, raw: unknown, summaryChars: number) {
  const args = TopicContextSchema.parse(raw);
  if (args.summary.length > summaryChars) throw new Error(`Topic summary exceeds ${summaryChars} characters; condense and retry`);
  const current = await resources.get<TopicSpec, TopicStatus>(resourceRef(owner));
  if (!current || current.metadata.deletionTimestamp || current.spec.parentRef || current.status.execution?.id !== executionId) throw new Error("Chief execution is no longer active");
  const all = await resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE);
  const target = topicSubtree(all, current).find(t => t.metadata.uid === (args.topicUid ?? current.metadata.uid));
  if (!target || target.metadata.resourceVersion !== args.version) throw new Error("Topic context changed; read_topic and merge again");
  const absorbed = { ...target.status.absorbed };
  const children = (args.absorbed ?? []).map(ref => {
    const child = all.find(t => t.metadata.uid === ref.uid && t.spec.parentRef?.uid === target.metadata.uid && !t.metadata.deletionTimestamp);
    if (!child || understandingVersion(child) !== ref.version) throw new Error("Child understanding changed; read and synthesize again");
    absorbed[ref.uid] = ref.version;
    return child;
  });
  await resources.commit([
    ...children.map(resource => ({ operation: "patchStatus" as const, resource, patch: {} })),
    ...(target.metadata.uid === current.metadata.uid ? [] : [{ operation: "patchStatus" as const, resource: current, patch: {} }]),
    { operation: "patchStatus", resource: target, patch: { summary: args.summary, absorbed,
      ...(args.recent ? { recent: [...target.status.recent, { at: new Date().toISOString(), text: args.recent }] } : {}) } },
  ]);
  const updated = (await resources.get<TopicSpec, TopicStatus>(resourceRef(target)))!;
  return { version: updated.metadata.resourceVersion, understandingVersion: understandingVersion(updated) };
}
