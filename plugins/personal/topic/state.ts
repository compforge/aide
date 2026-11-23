import { digest } from "../identity.ts";
import { writeSummary, type SummaryResource } from "../note/summary.ts";
import { contentVersion } from "../context-write.ts";
import { WriterResourceSchema, SubjectSchema } from "../note/model.ts";
import { patchStatus } from "../status.ts";
import { resourceRef } from "../input/state.ts";
import { readTopicInScope } from "./tree.ts";
import { z } from "zod";
import type { InputOrigin } from "../input/model.ts";
import { requireSummaryOrigin, upsertNote, NoteUpdateSchema } from "../note/service.ts";
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

export const TopicNoteSchema = NoteUpdateSchema.safeExtend({ topicId: z.string().min(1).optional(), summaryOf: SubjectSchema.optional() });
export type TopicNoteUpdate = z.infer<typeof TopicNoteSchema>;

/**
 * @spec Editing an existing Note preserves its subject; only move_note relocates it.
 * @spec A new Note defaults to the active Chief root; topicId may select a Topic in that tree.
 * @link docs/personal/note.md
 */
export async function upsertTopicNote(resources: ResourceClient, owner: Readonly<TopicResource>, executionId: string, raw: unknown, callId: string, maxChars = 4000, origin: InputOrigin = "chief") {
  const current = await resources.get<TopicSpec, TopicStatus>(resourceRef(owner));
  if (!current || current.metadata.uid !== owner.metadata.uid || current.metadata.deletionTimestamp || current.status.execution?.id !== executionId)
    throw new Error("Chief execution is no longer active");
  const { topicId, summaryOf, ...args } = TopicNoteSchema.parse(raw);
  if (summaryOf) {
    requireSummaryOrigin(origin, summaryOf.kind);
    if (topicId || args.noteId || args.subject || args.closedAt || args.followup !== undefined)
      throw new Error("Supply summaryOf to initialize a summary, or noteId to edit an existing Note");
    const target = await resources.get<unknown, SummaryResource["status"]>(summaryOf);
    if (!target || target.metadata.uid !== summaryOf.uid || target.metadata.deletionTimestamp) throw new Error("Summary owner changed; read it again");
    if (target.status.summaryRevision && !args.version) throw new Error("Summary already exists; read its Note and edit by noteId and version");
    if (summaryOf.kind === "Topic" && !await readTopicInScope(resources, current, target.metadata.uid)) throw new Error("Topic is outside this root");
    const { version, ...update } = args;
    if (version !== undefined && version !== contentVersion(target)) throw new Error("Summary owner version conflict");
    const writer = { resource: WriterResourceSchema.parse(resourceRef(current)), executionId };
    const result = await writeSummary(resources, target, { ...update, maxChars: update.maxChars ?? (target.status.summaryRevision ? undefined : maxChars) }, writer, contentVersion(target),
      target.kind === "Person" ? { updatedBy: "chief", updatedAt: new Date().toISOString() } : {});
    const note = result.summaryNote!;
    return { noteId: note.id, uid: note.uid, version: note.version, sensitivity: note.sensitivity, visibility: note.visibility,
      nature: note.nature, maxChars: note.maxChars, chars: update.text!.length, overBudget: update.text!.length > (note.maxChars ?? maxChars) };
  }
  if (topicId && args.noteId) throw new Error("topicId applies only to new Notes; use move_note to change an existing Note subject");
  if (topicId && args.subject) throw new Error("Choose topicId or subject, not both");
  if (topicId) {
    const target = await resources.get<TopicSpec, TopicStatus>({ ...TOPIC_TYPE, namespace: current.metadata.namespace, name: digest(topicId) });
    if (!target || !await readTopicInScope(resources, current, target.metadata.uid)) throw new Error("Topic is outside this root");
    args.subject = resourceRef(target) as typeof args.subject;
  }
  return upsertNote(resources, current, { ...args, ...(!args.noteId && args.maxChars === undefined ? { maxChars } : {}) }, callId, undefined, origin);
}
