import { SensitivitySchema, VisibilitySchema, disclosureScope } from "../disclosure.ts";
import { writeSummary, type SummaryResource } from "./summary.ts";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Resource, ResourceClient } from "@compforge/aide-plugin";
import { PersonRefSchema } from "../person/model.ts";
import { resourceRef } from "../input/state.ts";
import { NOTE_TYPE, WriterResourceSchema, SubjectSchema, noteView, noteVersion, type NoteSpec, type NoteStatus } from "./model.ts";

export const NoteUpdateSchema = z.object({ version: z.string().min(1).optional(), noteId: z.string().min(1).optional(),
  sensitivity: SensitivitySchema.optional(), visibility: VisibilitySchema.optional(),
  subject: SubjectSchema.optional(), text: z.string().trim().min(1).max(16000), people: z.array(PersonRefSchema).optional(),
}).strict().refine(a => !a.noteId || !!a.version, "Updating a Note requires its version");
export type NoteUpdate = z.infer<typeof NoteUpdateSchema>;
/** @spec A tool call creates one Note; updates compare only that Note's incarnation/version.
 * @spec Writer execution and current subject ownership are checked by the Note validator inside the write transaction.
 * @case tests/notes.test.ts
 * @link docs/personal/note.md
 */
export async function upsertNote(resources: ResourceClient, actor: Resource<unknown, { execution?: { id: string } | null }>,
  raw: unknown, callId: string) {
  const args = NoteUpdateSchema.parse(raw);
  if (!callId || !actor.status.execution) throw new Error("Note requires an active execution and tool-call identity");
  const writer = { resource: WriterResourceSchema.parse(resourceRef(actor)), executionId: actor.status.execution.id };
  const id = args.noteId ?? `note-${createHash("sha256").update(JSON.stringify([actor.metadata.uid, writer.executionId, callId])).digest("hex").slice(0, 32)}`;
  const ref = { ...NOTE_TYPE, namespace: "v1" as const, name: id };
  const previous = await resources.get<NoteSpec, NoteStatus>(ref);
  if (!args.noteId && previous && !previous.metadata.deletionTimestamp) return { noteId: id, version: noteVersion(previous) };
  if (args.noteId && (!previous || previous.metadata.deletionTimestamp)) throw new Error(`Note no longer exists: ${id}`);
  if (previous && noteVersion(previous) !== args.version) throw new Error("Note content version conflict; read the Note again");
  const visibility = args.visibility ?? previous?.spec.visibility ?? "people";
  const scope = previous?.spec.visibility === visibility ? previous.spec.disclosureScope : await disclosureScope(resources, args.subject ?? previous?.spec.subject ?? writer.resource, visibility);
  const { disclosureScope: _oldScope, ...previousSpec } = previous?.spec ?? {};
  const spec = { ...previousSpec, sensitivity: args.sensitivity ?? previous?.spec.sensitivity ?? "L3", visibility,
    ...(scope ? { disclosureScope: scope } : {}),
    subject: args.subject ?? previous?.spec.subject ?? writer.resource, text: args.text,
    people: args.people ? [...new Map(args.people.map(p => [p.uid, p])).values()] : previous?.spec.people ?? [] };
  if (previous && !isDeepStrictEqual(previous.spec.subject, spec.subject)) throw new Error("Use move_note to change an existing Note subject");
  if (previous?.spec.summaryOf) {
    const owner = await resources.get<SummaryResource["spec"], SummaryResource["status"]>(previous.spec.subject);
    if (owner) {
      if (owner.status.summaryRevision !== args.version) throw new Error("Note content version conflict; read the Note again");
      const updated = await writeSummary(resources, owner, { text: args.text, people: args.people, sensitivity: spec.sensitivity, visibility }, writer,
        undefined, owner.kind === "Person" ? { updatedAt: new Date().toISOString(), updatedBy: "chief" } : {});
      return { noteId: id, version: updated.status.summaryRevision! };
    }
  }
  if (previous && isDeepStrictEqual(previous.spec, spec)) return { noteId: id, version: noteVersion(previous) };
  const status = { ...previous?.status, updatedAt: new Date().toISOString(), writer };
  try {
    const updated = previous ? await resources.replace(previous, spec, status)
      : await resources.create(NOTE_TYPE, { name: id, spec, status });
    return { noteId: id, version: noteVersion(updated) };
  } catch (error) {
    if (args.noteId || !String(error).includes("already exists")) throw error;
    const duplicate = await resources.get<NoteSpec, NoteStatus>(ref);
    if (!duplicate || duplicate.metadata.deletionTimestamp) throw error;
    return { noteId: id, version: noteVersion(duplicate) };
  }
}

/** Read the complete stored matter when a context window or preview truncated it. */
export async function readNote(resources: ResourceClient, noteId: string) {
  const resource = await resources.get<NoteSpec, NoteStatus>({ ...NOTE_TYPE, namespace: "v1", name: noteId })
    ?? (await resources.page<NoteSpec, NoteStatus>(NOTE_TYPE, { namespace: "v1", limit: 1, matchIndex: { name: "uid", value: noteId } })).items[0];
  if (!resource || resource.metadata.deletionTimestamp) throw new Error(`Note no longer exists: ${noteId}`);
  return noteView(resource);
}
