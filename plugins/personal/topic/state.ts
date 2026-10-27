import { resourceRef } from "../input/state.ts";
import { topicSubtree, understandingVersion, summaryVersion } from "./tree.ts";
import { z } from "zod";
import { SUMMARY_CHARS } from "../context.ts";
import { upsertNote, NoteUpdateSchema } from "../notes.ts";
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

export const TopicContextSchema = z.object({ topicUid: z.string().optional(),
  absorbed: z.array(z.object({ uid: z.string(), version: z.string() }).strict()).max(20).optional(),
  version: z.string(), summary: z.string().max(SUMMARY_CHARS).optional(),
}).strict().refine(args => args.summary !== undefined || !!args.absorbed?.length, "Supply summary or reviewed child versions");
export type TopicContextUpdate = z.infer<typeof TopicContextSchema>;
export const TopicNoteSchema = NoteUpdateSchema.extend({ topicUid: z.string().optional() });
export type TopicNoteUpdate = z.infer<typeof TopicNoteSchema>;

async function targetTopic(resources: ResourceClient, owner: Readonly<TopicResource>, executionId: string, topicUid?: string) {
  const current = await resources.get<TopicSpec, TopicStatus>(resourceRef(owner));
  if (!current || current.metadata.uid !== owner.metadata.uid || current.metadata.deletionTimestamp || current.spec.parentRef
    || current.status.execution?.id !== executionId) throw new Error("Chief execution is no longer active");
  const all = await resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE);
  const target = topicSubtree(all, current).find(t => t.metadata.uid === (topicUid ?? current.metadata.uid));
  if (!target) throw new Error("Topic is outside this root");
  return { current, target, all };
}

/**
 * @spec Long-lived summary and child review receipts can change independently; neither appends a Note.
 * @spec Reviewed child versions are checked atomically before they can be reclaimed.
 * @case tests/notes.test.ts
 * @link docs/personal/topic.md#研判与上下文
 */
export async function summarizeTopic(resources: ResourceClient, owner: Readonly<TopicResource>, executionId: string, raw: unknown, summaryChars: number) {
  const args = TopicContextSchema.parse(raw);
  if (args.summary !== undefined && args.summary.length > summaryChars) throw new Error(`Topic summary exceeds ${summaryChars} characters; select more durable understanding`);
  const { current, target, all } = await targetTopic(resources, owner, executionId, args.topicUid);
  if (target.metadata.resourceVersion !== args.version) throw new Error("Topic context changed; read_topic and merge again");
  const absorbed = { ...target.status.absorbed }, absorbedSummaries = { ...target.status.absorbedSummaries };
  const children = (args.absorbed ?? []).map(ref => {
    const child = all.find(t => t.metadata.uid === ref.uid && t.spec.parentRef?.uid === target.metadata.uid && !t.metadata.deletionTimestamp);
    if (!child || understandingVersion(child) !== ref.version) throw new Error("Child understanding changed; read and review again");
    absorbed[ref.uid] = ref.version;
    absorbedSummaries[ref.uid] = summaryVersion(child);
    return child;
  });
  await resources.commit([
    ...children.map(resource => ({ operation: "patchStatus" as const, resource, patch: {} })),
    ...(target.metadata.uid === current.metadata.uid ? [] : [{ operation: "patchStatus" as const, resource: current, patch: {} }]),
    { operation: "patchStatus", resource: target, patch: { ...(args.summary !== undefined ? { summary: args.summary } : {}),
      ...(args.absorbed?.length ? { absorbed, absorbedSummaries } : {}) } },
  ]);
  const updated = (await resources.get<TopicSpec, TopicStatus>(resourceRef(target)))!;
  return { version: updated.metadata.resourceVersion, understandingVersion: understandingVersion(updated) };
}

export async function upsertTopicNote(resources: ResourceClient, owner: Readonly<TopicResource>, executionId: string, raw: unknown, callId: string) {
  const { topicUid, ...args } = TopicNoteSchema.parse(raw);
  const { current, target } = await targetTopic(resources, owner, executionId, topicUid);
  return upsertNote(resources, target, args, `${executionId}:${callId}`, target.metadata.uid === current.metadata.uid ? [] : [current]);
}
