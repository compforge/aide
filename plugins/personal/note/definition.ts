import { isDeepStrictEqual } from "node:util";
import { requireOrganization, requireTopic } from "../topic/ownership.ts";
import { noteVersion } from "./model.ts";
import { requireContentWriter } from "../context-write.ts";
import type { ResourceDefinition, ResourceValidationContext } from "@compforge/aide-plugin";
import { NOTE_TYPE, NoteSpecSchema, NoteStatusSchema, type NoteSpec, type NoteStatus, type NoteResource } from "./model.ts";

/** @spec Note links describe evidence, not ownership. Capacity alone controls retention.
 * @case tests/notes.test.ts
 * @link docs/personal/note.md
 */
function validate(note: NoteResource, context: ResourceValidationContext) {
  if (note.metadata.deletionTimestamp) throw new Error("Note is being deleted");
  if (note.metadata.namespace !== "v1" || note.metadata.owner) throw new Error("Note requires the shared namespace and an independent lifecycle");
  const writer = note.status.writer;
  const subject = context.get(note.spec.subject, note.spec.subject.uid);
  if (!subject || subject.metadata.name !== note.spec.subject.name || subject.metadata.namespace !== note.spec.subject.namespace) throw new Error("Note subject no longer exists");
  requireContentWriter(subject, writer, context);
}
export const NoteDefinition: ResourceDefinition<NoteSpec, NoteStatus> = {
  type: NOTE_TYPE, schema: { spec: NoteSpecSchema, status: NoteStatusSchema },
  validator: { create: validate, update: (before, after, context) => {
    if (!isDeepStrictEqual(before.spec.subject, after.spec.subject)) {
      const actor = context.get(after.status.writer.resource, after.status.writer.resource.uid);
      if (actor?.kind !== "Topic" || !after.status.organization || after.status.organization.reason.trim() === ""
        || !isDeepStrictEqual(after.status.organization.from, before.spec.subject) || !isDeepStrictEqual(after.status.organization.to, after.spec.subject))
        throw new Error("Note move requires an active root Chief and an organization reason");
      const source = context.get(before.spec.subject, before.spec.subject.uid);
      const target = context.get(after.spec.subject, after.spec.subject.uid);
      if (!source || !target) throw new Error("Note move subject no longer exists");
      requireContentWriter(source, after.status.writer, context);
      requireOrganization({ actorUid: actor.metadata.uid, executionId: after.status.writer.executionId,
        at: after.status.organization.at, reason: after.status.organization.reason }, context,
        [source, target].map(s => s.kind === "Topic" ? requireTopic({ ...s, ...s.metadata }, context)
          : requireTopic((s.status as { topic?: import("@compforge/aide-plugin").ResourceRef }).topic, context)));
      if (before.spec.text !== after.spec.text || !isDeepStrictEqual(before.spec.people, after.spec.people) || before.status.updatedAt !== after.status.updatedAt)
        throw new Error("Move Note separately from content edits");
    }
    if (!isDeepStrictEqual(before.status.reviewed, after.status.reviewed)
      && after.status.reviewed?.version !== noteVersion(after)) throw new Error("Note changed before review");
    validate(after, context);
  } },
  indexes: { unreviewed: r => !r.metadata.deletionTimestamp && r.status.reviewed?.version !== noteVersion(r) ? [r.spec.subject.uid] : [], subject: r => [r.spec.subject.uid], people: r => [...new Set(r.spec.people.map(p => p.uid))] },
  retention: { releasedAt: r => r.status.updatedAt, references: () => [] },
  printer: { describe: r => r.spec.text, summarize: r => r.spec.text.slice(0, 200) },
};
