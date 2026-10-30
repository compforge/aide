import { SensitivitySchema, VisibilitySchema } from "../disclosure.ts";
import { PersonRefSchema } from "../person/model.ts";
import { prepareSummary } from "../note/summary.ts";
import { contentVersion } from "../context-write.ts";
import { WriterResourceSchema, SubjectSchema } from "../note/model.ts";
import { readNotes } from "../note/query.ts";
import { patchStatus } from "../status.ts";
import { resourceRef } from "../input/state.ts";
import { readTopicInScope, understandingVersion, summaryVersion } from "./tree.ts";
import { z } from "zod";
import { SUMMARY_CHARS } from "../context.ts";
import { upsertNote, NoteUpdateSchema } from "../note/service.ts";
import { retryOnConflict, type ResourceClient } from "@compforge/aide-plugin";
import { TOPIC_TYPE, type TopicResource, type TopicSpec, type TopicStatus } from "./model.ts";

/** @spec A stale execution cannot mutate a replacement Topic. */
export async function updateTopic(resources: ResourceClient, ref: Readonly<TopicResource>,
  change: (current: Readonly<TopicResource>) => Partial<TopicStatus>): Promise<Readonly<TopicResource>> {
  return retryOnConflict(async () => {
    const current = await resources.get<TopicSpec, TopicStatus>({ ...TOPIC_TYPE, ...ref.metadata });
    if (!current || current.metadata.uid !== ref.metadata.uid || current.metadata.deletionTimestamp) throw new Error("Topic no longer exists");
    const patch = change(current);
    if (!Object.keys(patch).length) return current;
    return patchStatus(resources, current, patch);
  });
}

export const TopicContextSchema = z.object({ topicUid: z.string().optional(),
  absorbed: z.array(z.object({ uid: z.string(), version: z.string() }).strict()).max(20).optional(),
  sensitivity: SensitivitySchema.optional(), visibility: VisibilitySchema.optional(), version: z.string(), people: z.array(PersonRefSchema).optional(), summary: z.string().max(SUMMARY_CHARS).optional(),
}).strict().refine(args => args.summary !== undefined || args.people !== undefined || args.sensitivity !== undefined || args.visibility !== undefined || !!args.absorbed?.length, "Supply summary, classification or reviewed child versions");
export type TopicContextUpdate = z.infer<typeof TopicContextSchema>;
export const TopicNoteSchema = NoteUpdateSchema;
export type TopicNoteUpdate = z.infer<typeof TopicNoteSchema>;

async function targetTopic(resources: ResourceClient, owner: Readonly<TopicResource>, executionId: string, topicUid?: string) {
  const current = await resources.get<TopicSpec, TopicStatus>(resourceRef(owner));
  if (!current || current.metadata.uid !== owner.metadata.uid || current.metadata.deletionTimestamp
    || current.status.execution?.id !== executionId) throw new Error("Chief execution is no longer active");
  const target = await readTopicInScope(resources, current, topicUid);
  if (!target) throw new Error("Topic is outside this root");
  return { current, target };
}

/**
 * @spec Long-lived summary and child review receipts can change independently; neither appends a matter Note.
 * @spec Reviewed child versions are checked atomically before they can be reclaimed.
 * @case tests/notes.test.ts
 * @link docs/personal/topic.md#研判与上下文
 */
export async function summarizeTopic(resources: ResourceClient, owner: Readonly<TopicResource>, executionId: string, raw: unknown, summaryChars: number) {
  const args = TopicContextSchema.parse(raw);
  if (args.summary !== undefined && args.summary.length > summaryChars) throw new Error(`Topic summary exceeds ${summaryChars} characters; select more durable understanding`);
  const { current, target } = await targetTopic(resources, owner, executionId, args.topicUid);
  if (contentVersion(target) !== args.version) throw new Error("Topic context changed; read_topic and merge again");
  const absorbed = { ...target.status.absorbed }, absorbedSummaries = { ...target.status.absorbedSummaries };
  const children = await Promise.all((args.absorbed ?? []).map(async ref => {
    const child = (await resources.page<TopicSpec, TopicStatus>(TOPIC_TYPE, { limit: 1, matchIndex: { name: "uid", value: ref.uid } })).items[0];
    if (!child || child.metadata.deletionTimestamp || child.spec.parentRef?.uid !== target.metadata.uid || understandingVersion(child, await readNotes(resources, child.metadata.uid, "subject")) !== ref.version) throw new Error("Child understanding changed; read and review again");
    absorbed[ref.uid] = ref.version;
    absorbedSummaries[ref.uid] = summaryVersion(child);
    return child;
  }));
  const writer = { resource: WriterResourceSchema.parse(resourceRef(current)), executionId };
  const prepared = [args.summary, args.people, args.sensitivity, args.visibility].every(v => v === undefined) ? { writes: [], status: {} } : await prepareSummary(resources, target, { text: args.summary, people: args.people, sensitivity: args.sensitivity, visibility: args.visibility }, writer, args.version);
  const committed = await resources.commit([...prepared.writes, { operation: "patch", resource: target, patch: { type: "json", value: [
    ...(target.status.summaryRevision === undefined ? [] : [{ op: "test" as const, path: "/status/summaryRevision", value: target.status.summaryRevision }]),
    ...Object.entries(prepared.status).map(([key, value]) => ({ op: "add" as const, path: `/status/${key}`, value })),
    { op: "add", path: "/status/contextWriter", value: { resource: WriterResourceSchema.parse(resourceRef(current)), executionId } },
    ...children.flatMap(child => [
      { op: "add" as const, path: `/status/absorbed/${child.metadata.uid}`, value: absorbed[child.metadata.uid] },
      { op: "add" as const, path: `/status/absorbedSummaries/${child.metadata.uid}`, value: absorbedSummaries[child.metadata.uid] },
    ]),
  ] } }]);
  const updated = committed.at(-1) as TopicResource;
  return { version: contentVersion(updated), understandingVersion: understandingVersion(updated, await readNotes(resources, updated.metadata.uid, "subject")) };
}

export async function upsertTopicNote(resources: ResourceClient, owner: Readonly<TopicResource>, executionId: string, raw: unknown, callId: string) {
  const { current } = await targetTopic(resources, owner, executionId);
  return upsertNote(resources, current, raw, callId);
}
