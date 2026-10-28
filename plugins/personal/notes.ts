import { isDeepStrictEqual } from "node:util";
import { PersonRefSchema } from "./person/model.ts";
import { commitStatus } from "./status.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Resource, ResourceClient } from "@compforge/aide-plugin";
import { retainRecent, RECENT_CHARS, type ResourceContext } from "./context.ts";
import { resourceRef } from "./input/state.ts";

export const NoteUpdateSchema = z.object({ version: z.string().min(1), noteId: z.string().min(1).optional(), text: z.string().trim().min(1).max(RECENT_CHARS), persons: z.array(PersonRefSchema).optional() }).strict();
export type NoteUpdate = z.infer<typeof NoteUpdateSchema>;

/**
 * @spec A Note belongs to one resource. Existing IDs must exist; stale updates cannot recreate evicted Notes.
 * @spec Omitted persons preserve prior associations; [] clears them. Historical references can be copied from prior evidence even after Person deletion.
 * @spec Creation retries reuse the tool-call identity without overwriting subsequent progress or changing summary.
 * @case tests/notes.test.ts
 * @link docs/personal/README.md#有界认识与近期依据
 */
export async function upsertNote(resources: ResourceClient, owner: Readonly<Resource<unknown, ResourceContext>>, raw: unknown,
  callId: string, fences: readonly Resource<unknown, unknown>[] = []) {
  const args = NoteUpdateSchema.parse(raw);
  if (!callId) throw new Error("Note creation requires a tool-call identity");
  const id = args.noteId ?? `note-${createHash("sha256").update(JSON.stringify([owner.metadata.uid, callId])).digest("hex").slice(0, 32)}`;
  const notes = owner.status.recent;
  const previous = notes.find(note => note.id === id);
  if (!args.noteId && previous) return { noteId: id, version: owner.metadata.resourceVersion };
  if (owner.metadata.resourceVersion !== args.version) throw new Error("Note resource version conflict; read the target again");
  if (args.noteId && !previous) throw new Error(`Note no longer exists on this resource: ${args.noteId}`);
  const persons = args.persons === undefined ? previous?.persons : [...new Map(args.persons.map(ref => [ref.uid, ref])).values()];
  if (previous?.text === args.text && isDeepStrictEqual(previous?.persons, persons)) return { noteId: id, version: owner.metadata.resourceVersion };
  const at = new Date().toISOString();
  const note = { id, createdAt: previous?.createdAt ?? at, updatedAt: at, text: args.text, ...(persons === undefined ? {} : { persons }) };
  await commitStatus(resources, [
    ...fences.map(resource => ({ operation: "patchStatus" as const, resource, patch: {} })),
    { operation: "patchStatus", resource: owner, patch: { recent: retainRecent([...notes.filter(item => item.id !== id), note]) } },
  ]);
  const updated = (await resources.get<unknown, ResourceContext>(resourceRef(owner)))!;
  return { noteId: id, version: updated.metadata.resourceVersion };
}
