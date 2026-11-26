import type { InputOrigin } from "../input/model.ts";
import { AddressRefsSchema, addressRefs } from "../address/model.ts";
import { SensitivitySchema, VisibilitySchema } from "../disclosure.ts";
import { publishSummaryRevision, writeSummary, type SummaryResource } from "./summary.ts";
import { equalResourceValue } from "../../../src/resource/value.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Resource, ResourceClient, ResourceCommit } from "@compforge/aide-plugin";
import { personRefs, PersonRefsSchema } from "../person/model.ts";
import { readTopicRoot } from "../topic/tree.ts";
import { resourceRef } from "../input/state.ts";
import { clearCurationSchedule, NOTE_TYPE, pendingCuration, noteMaterial, NoteNameSchema, NoteNatureSchema, MaxCharsSchema, noteMaxChars, WriterResourceSchema, SubjectSchema, noteView, noteVersion, type NoteSpec, type NoteStatus, type NoteResource } from "./model.ts";

export const NoteUpdateSchema = z.object({ version: z.string().min(1).optional(), noteId: z.string().min(1).optional(),
  name: NoteNameSchema.optional(), nature: NoteNatureSchema.optional(), maxChars: MaxCharsSchema.optional(),
  sensitivity: SensitivitySchema.optional(), visibility: VisibilitySchema.optional(),
  addresses: AddressRefsSchema.optional(), subject: SubjectSchema.optional(), text: z.string().trim().max(16000).optional(), people: PersonRefsSchema().optional(),
}).strict().refine(a => !a.noteId || !!a.version, "Updating a Note requires its version")
  .refine(a => !!a.noteId || !!a.text, "Creating a Note requires text")
  .refine(a => [a.name, a.text, a.people, a.addresses, a.sensitivity, a.visibility, a.nature, a.maxChars].some(v => v !== undefined), "Supply Note content or classification");
export type NoteUpdate = z.infer<typeof NoteUpdateSchema>;
export function requireSummaryOrigin(origin: InputOrigin, kind: string) {
  if (origin === "aide:summary" && ["Topic", "Person", "Address"].includes(kind)) return;
  throw new Error("Summary Note is read-only for this Input");
}

export function noteReceipt(note: NoteResource) {
  return { noteId: note.metadata.name, uid: note.metadata.uid, version: noteVersion(note),
    maxChars: noteMaxChars(note.spec), chars: note.spec.text.length, overBudget: note.spec.text.length > noteMaxChars(note.spec), nature: note.spec.nature,
    sensitivity: note.spec.sensitivity ?? "L3", visibility: note.spec.visibility ?? "people" };
}
/** @spec Receipts expose noteId for mutation, uid/version for citation and the stored sensitivity/visibility, including defaults and retries.
 * @spec A tool call creates one Note; updates compare only that Note's incarnation/version.
 * @spec Writer execution and current subject ownership are checked by the Note validator inside the write transaction.
 * @case tests/notes.test.ts
 * @link docs/personal/note.md
 */
export async function upsertNote(resources: ResourceClient, actor: Resource<unknown, { execution?: { id: string } | null }>,
  raw: unknown, callId: string, pruning?: NoteStatus["pruned"], origin?: InputOrigin) {
  const args = NoteUpdateSchema.parse(raw);
  if (!callId || !actor.status.execution) throw new Error("Note requires an active execution and tool-call identity");
  const writer = { resource: WriterResourceSchema.parse(resourceRef(actor)), executionId: actor.status.execution.id };
  const id = args.noteId ?? `note-${createHash("sha256").update(JSON.stringify([actor.metadata.uid, writer.executionId, callId])).digest("hex").slice(0, 32)}`;
  const ref = { ...NOTE_TYPE, namespace: "v1" as const, name: id };
  const previous = await resources.get<NoteSpec, NoteStatus>(ref);
  if (!args.noteId && previous && !previous.metadata.deletionTimestamp) return noteReceipt(previous);
  if (args.noteId && (!previous || previous.metadata.deletionTimestamp)) throw new Error(`Note no longer exists: ${id}`);
  if (previous?.spec.summaryOf && origin) requireSummaryOrigin(origin, previous.spec.summaryOf.kind);
  if (args.text === "" && (!previous?.spec.summaryOf || pruning)) throw new Error("An ordinary Note requires nonempty text");
  if (previous?.status.retired) throw new Error("Note is retired; create or update an active Note");
  if (previous && noteVersion(previous) !== args.version) throw new Error("Note content version conflict; read the Note again");
  if (pruning && (!previous || args.text === undefined || args.text.length >= previous.spec.text.length))
    throw new Error("Pruning requires a shorter nonempty body; use retire_note to discard a Note");
  const visibility = args.visibility ?? previous?.spec.visibility ?? "people";
  const spec = { ...previous?.spec,
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.nature !== undefined ? { nature: args.nature } : {}),
    ...(args.maxChars !== undefined ? { maxChars: args.maxChars } : !previous ? { maxChars: noteMaxChars({}) } : {}), sensitivity: args.sensitivity ?? previous?.spec.sensitivity ?? "L3", visibility,
    subject: args.subject ?? previous?.spec.subject ?? writer.resource, text: args.text ?? previous?.spec.text ?? "",
    people: args.people ?? previous?.spec.people ?? personRefs([]), addresses: args.addresses ?? previous?.spec.addresses ?? addressRefs([]) };
  const now = Date.now();
  if (previous && !equalResourceValue(previous.spec.subject, spec.subject)) throw new Error("Use move_note to change an existing Note subject");
  if (previous?.spec.summaryOf) {
    const owner = await resources.get<SummaryResource["spec"], SummaryResource["status"]>(previous.spec.subject);
    if (owner) {
      if (owner.status.summaryRevision !== args.version) throw new Error("Note content version conflict; read the Note again");
      const updated = await writeSummary(resources, owner, { name: args.name, text: args.text ?? previous?.spec.text ?? "", people: args.people, addresses: args.addresses, sensitivity: spec.sensitivity, visibility, nature: spec.nature, maxChars: spec.maxChars, pruned: pruning }, writer,
        undefined, owner.kind === "Person" ? { updatedAt: new Date().toISOString(), updatedBy: "chief" } : {});
      const note = updated.summaryNote!;
      return { noteId: note.id, uid: note.uid, version: note.version,
        sensitivity: note.sensitivity, visibility: note.visibility, nature: note.nature, maxChars: note.maxChars, chars: spec.text.length, overBudget: spec.text.length > noteMaxChars(spec) };
    }
  }
  if (previous && equalResourceValue(previous.spec, spec)) return noteReceipt(previous);
  const updatedAt = new Date(now).toISOString();
  const topic = actor.kind === "Topic" ? writer.resource : (actor.status as import("../work/model.ts").WorkStatus).topic;
  const root = topic && await readTopicRoot(resources, topic);
  const sameMaterial = previous && noteMaterial(previous.spec) === noteMaterial(spec);
  const status = { ...(previous && (sameMaterial ? previous.status : clearCurationSchedule(previous.status))), updatedAt, writer, curationRoot: root?.metadata.uid,
    pendingSince: sameMaterial ? previous.status.pendingSince : (previous && pendingCuration(previous)) ?? updatedAt, ...(pruning ? { pruned: pruning } : {}) };
  try {
    const updated = previous ? await resources.replace(previous, spec, status)
      : await resources.create(NOTE_TYPE, { name: id, spec, status });
    return noteReceipt(updated);
  } catch (error) {
    if (args.noteId || !String(error).includes("already exists")) throw error;
    const duplicate = await resources.get<NoteSpec, NoteStatus>(ref);
    if (!duplicate || duplicate.metadata.deletionTimestamp) throw error;
    return noteReceipt(duplicate);
  }
}

/** Read the complete stored matter when a context window or preview truncated it. */
export async function readNote(resources: ResourceClient, noteId: string) {
  const resource = await resources.get<NoteSpec, NoteStatus>({ ...NOTE_TYPE, namespace: "v1", name: noteId })
    ?? (await resources.page<NoteSpec, NoteStatus>(NOTE_TYPE, { namespace: "v1", limit: 1, matchIndex: { name: "uid", value: noteId } })).items[0];
  if (!resource || resource.metadata.deletionTimestamp) throw new Error(`Note no longer exists: ${noteId}`);
  return noteView(resource);
}

export const ReduceNoteSchema = z.object({ noteId: z.string().min(1), version: z.string().min(1),
  reason: z.string().trim().min(1).max(2000) }).strict();
export const PruneNoteSchema = ReduceNoteSchema.extend({ text: z.string().trim().min(1).max(16000) });
type NoteActor = Resource<unknown, { execution?: { id: string } | null }>;
/** @spec Prune keeps a nonempty shorter body; retirement preserves body, citations and content age.
 * @why Save destination information first, then subtract from the source; interruption may duplicate but must not lose facts.
 * @link docs/personal/note.md
 */
export async function pruneNote(resources: ResourceClient, actor: NoteActor, raw: unknown, callId: string, origin?: InputOrigin) {
  const { reason, ...args } = PruneNoteSchema.parse(raw);
  if (!actor.status.execution) throw new Error("Note pruning requires an active execution");
  const writer = { resource: WriterResourceSchema.parse(resourceRef(actor)), executionId: actor.status.execution.id };
  return upsertNote(resources, actor, args, callId, { at: new Date().toISOString(), reason, writer }, origin);
}
export async function retireNote(resources: ResourceClient, actor: NoteActor, raw: unknown, origin: InputOrigin = "chief") {
  const args = ReduceNoteSchema.parse(raw);
  if (!actor.status.execution) throw new Error("Note retirement requires an active execution");
  const note = await resources.get<NoteSpec, NoteStatus>({ ...NOTE_TYPE, namespace: "v1", name: args.noteId });
  if (!note || note.metadata.deletionTimestamp || noteVersion(note) !== args.version) throw new Error("Note content version conflict; read_note again");
  const writer = { resource: WriterResourceSchema.parse(resourceRef(actor)), executionId: actor.status.execution.id };
  if (note.spec.summaryOf) requireSummaryOrigin(origin, note.spec.summaryOf.kind);
  if (note.status.retired) return { ...noteReceipt(note), retired: note.status.retired };
  const retired = { at: new Date().toISOString(), reason: args.reason, writer };
  const writes: ResourceCommit[] = [];
  if (note.spec.summaryOf) {
    const owner = await resources.get<unknown, SummaryResource["status"]>(note.spec.summaryOf);
    if (!owner || owner.metadata.uid !== note.spec.summaryOf.uid)
      throw new Error("Summary owner changed; read the Note again");
    writes.push(publishSummaryRevision(owner, args.version, "", writer, retired.at, note.metadata.uid));
  }
  writes.push({ operation: "patchStatus", resource: note, patch: { retired, writer }, options: { resourceVersion: note.metadata.resourceVersion } });
  const results = await resources.commit(writes);
  return { ...noteReceipt(results.at(-1) as NoteResource), retired };
}
