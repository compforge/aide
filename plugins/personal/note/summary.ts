import { isDeepStrictEqual } from "node:util";
import type { Resource, ResourceClient, ResourceCommit, ResourceValidationContext } from "@compforge/aide-plugin";
import { NOTE_TYPE, SubjectSchema, NoteSpecSchema, noteReference, noteVersion, type NoteResource, type NoteSpec, type NoteStatus } from "./model.ts";
import { resourceRef } from "../input/state.ts";
import { contentVersion } from "../context-write.ts";
import type { ResourceContext } from "../context.ts";

export interface SummaryUpdate { text: string; people?: NoteSpec["people"] }
export type SummaryResource = Resource<unknown, ResourceContext>;
const summaryName = (resource: SummaryResource) => `summary-${resource.metadata.uid}`;
type Reader = Pick<ResourceValidationContext, "page">;
export function summaryNote(reader: Reader, resource: SummaryResource): NoteResource | undefined {
  const note = reader.page<NoteSpec, NoteStatus>(NOTE_TYPE, { limit: 1, matchIndex: { name: "summaryOf", value: resource.metadata.uid } }).items[0];
  if (!note && !resource.status.summaryRevision) return;
  if (!note || note.metadata.deletionTimestamp || note.spec.subject.uid !== resource.metadata.uid || noteVersion(note) !== resource.status.summaryRevision) throw new Error("Summary Note changed; read its resource again");
  return note;
}
export const summaryReference = (reader: Reader, resource: SummaryResource) => noteReference(summaryNote(reader, resource));
export const summaryText = (reader: Reader, resource: SummaryResource) => summaryNote(reader, resource)?.spec.text ?? "";
export async function readSummary(resources: ResourceClient, resource: SummaryResource) {
  const note = (await resources.page<NoteSpec, NoteStatus>(NOTE_TYPE, { namespace: "v1", limit: 1, matchIndex: { name: "summaryOf", value: resource.metadata.uid } })).items[0];
  if (!note && !resource.status.summaryRevision) return;
  if (!note || note.metadata.deletionTimestamp || note.spec.subject.uid !== resource.metadata.uid || noteVersion(note) !== resource.status.summaryRevision) throw new Error("Summary Note changed; read its resource again");
  return note;
}
/** @spec Text lives only in the Note; summaryOf is the indexed association; owner status retains only a derived fingerprint. */
export async function summaryView<R extends SummaryResource>(resources: ResourceClient, resource: R) {
  const note = await readSummary(resources, resource);
  return { ...resource, summaryText: note?.spec.text ?? "", summaryNote: noteReference(note), summaryVersion: contentVersion(resource) };
}

/**
 * @spec Publish the Note content, summaryOf and derived owner fingerprint in one commit. Scheduling fields are not a precondition.
 * @why The fingerprint is a derived dependency token for pure Topic indexes and Watch, never a second copy of knowledge.
 * @link docs/personal/note.md
 * @case tests/summary-notes.test.ts
 */
export async function prepareSummary(resources: ResourceClient, owner: SummaryResource, update: SummaryUpdate,
  writer?: NoteStatus["writer"], version = contentVersion(owner)) {
  if (contentVersion(owner) !== version) throw new Error("Summary version conflict; read and merge again");
  const { text } = update;
  if (text.length > 16000) throw new Error("Summary exceeds 16000 characters");
  let note = await readSummary(resources, owner);
  if (!note && !text && !update.people?.length) return { note: undefined, writes: [] as ResourceCommit[], status: { summaryRevision: "" } };
  if (!note) {
    // An empty reserved Note is safe across retries; only the commit below publishes content and its reference.
    const name = summaryName(owner);
    note = await resources.get<NoteSpec, NoteStatus>({ ...NOTE_TYPE, namespace: "v1", name });
    if (!note) {
      try { note = await resources.create(NOTE_TYPE, { name,
        spec: { subject: SubjectSchema.parse(resourceRef(owner)), people: [], text: "" },
        status: { updatedAt: new Date().toISOString(), ...(writer ? { writer } : {}) } }); }
      catch (error) {
        if (!(error instanceof Error) || error.name !== "ResourceAlreadyExists") throw error;
        note = await resources.get<NoteSpec, NoteStatus>({ ...NOTE_TYPE, namespace: "v1", name });
        if (!note) throw error;
      }
    }
  }
  if (note.metadata.deletionTimestamp || note.spec.subject.uid !== owner.metadata.uid) throw new Error("Summary Note owner changed");
  const people = update.people === undefined ? note.spec.people : [...new Map(update.people.map(p => [p.uid, p])).values()];
  const spec = NoteSpecSchema.parse({ ...note.spec, summaryOf: resourceRef(owner), text, people });
  const changed = !isDeepStrictEqual(note.spec, spec);
  const { writer: _previousWriter, ...noteStatus } = note.status;
  const updated: NoteResource = { ...note, spec, status: { ...noteStatus,
    ...(changed ? { updatedAt: new Date().toISOString() } : {}), ...(writer ? { writer } : {}) } };
  const writes: ResourceCommit[] = [{ operation: "patch", resource: note, patch: { type: "json", value: [
    { op: "test", path: "/spec", value: note.spec },
    { op: "test", path: "/status/updatedAt", value: note.status.updatedAt },
    { op: "replace", path: "/spec", value: spec },
    { op: "replace", path: "/status", value: updated.status },
  ] } }];
  return { note: updated, writes, status: { summaryRevision: noteVersion(updated) } };
}
export async function writeSummary<R extends SummaryResource>(resources: ResourceClient, owner: R, update: SummaryUpdate,
  writer?: NoteStatus["writer"], version = contentVersion(owner), patch: Record<string, unknown> = {}) {
  const prepared = await prepareSummary(resources, owner, update, writer, version);
  const results = await resources.commit([...prepared.writes, { operation: "patch", resource: owner, patch: { type: "json", value: [
    ...(owner.status.summaryRevision === undefined ? [] : [{ op: "test" as const, path: "/status/summaryRevision", value: owner.status.summaryRevision }]),
    ...(!writer && owner.status.contextWriter ? [{ op: "remove" as const, path: "/status/contextWriter" }] : []),
    ...Object.entries({ ...patch, ...prepared.status, ...(writer ? { contextWriter: writer } : {}) })
      .map(([key, value]) => ({ op: "add" as const, path: `/status/${key}`, value })),
  ] } }]);
  return { ...results.at(-1) as R, summaryNote: noteReference(prepared.note) };
}

export function validateSummary(resource: SummaryResource, context: ResourceValidationContext) {
  if (!resource.status.summaryRevision) return;
  const note = context.page<NoteSpec, NoteStatus>(NOTE_TYPE, { namespace: "v1", limit: 1,
    matchIndex: { name: "summaryOf", value: resource.metadata.uid } }).items[0];
  if ((note ? noteVersion(note) : "") !== (resource.status.summaryRevision ?? ""))
    throw new Error("Summary revision must match its Note content");
}
