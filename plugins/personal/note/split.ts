import type { ResourceClient, ResourceCommit } from "@compforge/aide-plugin";
import { z } from "zod";
import { digest } from "../identity.ts";
import type { InputOrigin } from "../input/model.ts";
import { resourceRef } from "../input/state.ts";
import type { TopicResource } from "../topic/model.ts";
import { readTopicRoot } from "../topic/tree.ts";
import { NOTE_TYPE, NoteNameSchema, NoteNatureSchema, SubjectSchema, WriterResourceSchema, noteVersion, pendingCuration, type NoteResource, type NoteSpec, type NoteStatus } from "./model.ts";
import { noteReceipt, PruneNoteSchema, requireSummaryOrigin } from "./service.ts";
import { publishSummaryRevision, type SummaryResource } from "./summary.ts";

const PartSchema = z.object({ text: z.string().trim().min(1).max(16000), name: NoteNameSchema.optional(),
  nature: NoteNatureSchema.optional(), subject: SubjectSchema.optional() }).strict();
const SplitNoteSchema = PruneNoteSchema.extend({ parts: z.array(PartSchema).min(1).max(98) });

/** @spec The source keeps its identity and Summary role. Creating every ordinary part, shortening the source and publishing its owner revision are atomic.
 * @why Derive part IDs from the source version and complete request so repeating an acknowledged or interrupted split cannot create extra Notes.
 * @link docs/personal/note.md
 * @case tests/note-knowledge.test.ts
 */
export async function splitNote(resources: ResourceClient, actor: TopicResource, raw: unknown, origin: InputOrigin) {
  const args = SplitNoteSchema.parse(raw);
  if (!actor.status.execution || (origin !== "aide:curate" && origin !== "aide:organize" && origin !== "aide:summary"))
    throw new Error("Splitting requires an active Chief handling Note maintenance");
  const get = (name: string) => resources.get<NoteSpec, NoteStatus>({ ...NOTE_TYPE, namespace: "v1", name });
  const source = await get(args.noteId);
  if (!source || source.metadata.deletionTimestamp || source.status.retired) throw new Error("Read an active Note before splitting");
  if (source.spec.summaryOf) requireSummaryOrigin(origin, source.spec.summaryOf.kind);
  const sourceUid = source.metadata.uid;
  const key = digest([actor.metadata.uid, sourceUid, args]);
  const ids = args.parts.map((_, i) => `split-${key}-${i}`);
  // On replay, identities are safe to reuse. Re-read any intervening edits before acknowledging a curated version.
  async function replay() {
    const parts = await Promise.all(ids.map(get));
    if (!parts.every(p => p && p.status.splitFrom?.uid === sourceUid && p.status.splitFrom.version === args.version)) return;
    return { replayed: true, source: { noteId: args.noteId }, parts: ids.map(noteId => ({ noteId })) };
  }
  if (noteVersion(source) !== args.version) {
    const receipt = await replay();
    if (receipt) return receipt;
    throw new Error("Note content version conflict; read_note again");
  }
  if (args.text.length >= source.spec.text.length) throw new Error("Split requires a shorter nonempty remaining body");
  const writer = { resource: WriterResourceSchema.parse(resourceRef(actor)), executionId: actor.status.execution.id };
  const now = new Date().toISOString();
  const root = await readTopicRoot(resources, writer.resource);
  const updated = { ...source, spec: { ...source.spec, text: args.text }, status: { ...source.status, updatedAt: now, writer,
    pruned: { at: now, reason: args.reason, writer }, ...(!source.spec.summaryOf ? { curationRoot: root?.metadata.uid, pendingSince: pendingCuration(source) ?? now } : {}) } };
  const writes: ResourceCommit[] = args.parts.map((part, i) => ({ operation: "create", type: NOTE_TYPE, name: ids[i]!,
    spec: { ...part, subject: part.subject ?? source.spec.subject, people: source.spec.people, addresses: source.spec.addresses,
      sensitivity: source.spec.sensitivity, visibility: source.spec.visibility, maxChars: source.spec.maxChars },
    status: { writer, updatedAt: now, pendingSince: now, curationRoot: root?.metadata.uid, splitFrom: { uid: source.metadata.uid, version: args.version } } }));
  writes.push({ operation: "replace", resource: source, spec: updated.spec, status: updated.status });
  if (source.spec.summaryOf) {
    const owner = await resources.get<unknown, SummaryResource["status"]>(source.spec.summaryOf);
    if (!owner || owner.metadata.uid !== source.spec.summaryOf.uid)
      throw new Error("Summary owner changed; read the Note again");
    writes.push(publishSummaryRevision(owner, args.version, noteVersion(updated), writer, now));
  }
  try {
    const results = await resources.commit(writes);
    return { replayed: false, source: noteReceipt(results[ids.length] as NoteResource), parts: results.slice(0, ids.length).map(r => noteReceipt(r as NoteResource)) };
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "ResourceAlreadyExists") throw error;
    const receipt = await replay();
    if (!receipt) throw error;
    return receipt;
  }
}
