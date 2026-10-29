import { requireContentWriter } from "../context-write.ts";
import type { ResourceDefinition, ResourceValidationContext } from "@compforge/aide-plugin";
import { NOTE_TYPE, NoteSpecSchema, NoteStatusSchema, type NoteSpec, type NoteStatus, type NoteResource } from "./model.ts";

/** @spec Note links describe evidence, not ownership. Capacity alone controls retention.
 * @case tests/notes.test.ts
 * @link docs/personal/note.md
 */
function validate(note: NoteResource, context: ResourceValidationContext) {
  if (note.metadata.namespace !== "v1" || note.metadata.owner) throw new Error("Note requires the shared namespace and an independent lifecycle");
  const writer = note.status.writer;
  const subject = context.get(note.spec.subject, note.spec.subject.uid);
  if (!subject || subject.metadata.name !== note.spec.subject.name || subject.metadata.namespace !== note.spec.subject.namespace) throw new Error("Note subject no longer exists");
  requireContentWriter(subject, writer, context);
}
export const NoteDefinition: ResourceDefinition<NoteSpec, NoteStatus> = {
  type: NOTE_TYPE, schema: { spec: NoteSpecSchema, status: NoteStatusSchema },
  validator: { create: validate, update: (before, after, context) => {
    if (JSON.stringify(before.spec.subject) !== JSON.stringify(after.spec.subject)) throw new Error("Note subject is immutable");
    validate(after, context);
  } },
  indexes: { subject: r => [r.spec.subject.uid], people: r => [...new Set(r.spec.people.map(p => p.uid))] },
  retention: { releasedAt: r => r.status.updatedAt, references: () => [] },
  printer: { describe: r => r.spec.text, summarize: r => r.spec.text.slice(0, 200) },
};
