import { sensitivityRank } from "../disclosure.ts";
import { equalResourceValue } from "../../../src/resource/value.ts";
import { requireOrganization, requireTopic } from "../topic/ownership.ts";
import { noteVersion } from "./model.ts";
import { requireContentWriter } from "../context-write.ts";
import type { ResourceDefinition, ResourceValidationContext } from "@compforge/aide-plugin";
import { NOTE_TYPE, NoteSpecSchema, NoteStatusSchema, type NoteSpec, type NoteStatus, type NoteResource } from "./model.ts";

/** @spec Note is independent knowledge. summaryOf identifies the subject whose long-lived understanding it holds.
 * @case tests/notes.test.ts
 * @link docs/personal/note.md
 */
function validateAddresses(note: NoteResource, context: ResourceValidationContext) {
  for (const ref of note.spec.addresses) {
    const address = context.get(ref, ref.uid);
    if (!address || address.metadata.deletionTimestamp || address.metadata.name !== ref.name) throw new Error("Associated Address no longer exists");
  }
}
function validate(note: NoteResource, context: ResourceValidationContext) {
  if (note.metadata.deletionTimestamp) throw new Error("Note is being deleted");
  if (note.metadata.namespace !== "v1" || note.metadata.owner) throw new Error("Note requires the shared namespace and an independent lifecycle");
  const writer = note.status.writer;
  const subject = context.get(note.spec.subject, note.spec.subject.uid);
  if (!subject || subject.metadata.deletionTimestamp || subject.metadata.name !== note.spec.subject.name || subject.metadata.namespace !== note.spec.subject.namespace) throw new Error("Note subject no longer exists");
  if (note.spec.summaryOf) {
    if (!equalResourceValue(note.spec.subject, note.spec.summaryOf)) throw new Error("Summary Note subject must match summaryOf");
    const summaries = context.page<NoteSpec, NoteStatus>(NOTE_TYPE, { namespace: "v1", limit: 2,
      matchIndex: { name: "summaryOf", value: note.spec.summaryOf.uid } }).items;
    if (summaries.some(n => n.metadata.uid !== note.metadata.uid)) throw new Error("Subject already has a summary Note");
  }
  if (writer) requireContentWriter(subject, writer, context);
}
export const NoteDefinition: ResourceDefinition<NoteSpec, NoteStatus> = {
  type: NOTE_TYPE, schema: { spec: NoteSpecSchema, status: NoteStatusSchema },
  validator: { create: (note, context) => { validateAddresses(note, context); validate(note, context); }, update: (before, after, context) => {
    if (!equalResourceValue(before.spec.addresses, after.spec.addresses)) validateAddresses(after, context);
    if (!equalResourceValue(before.spec.addresses, after.spec.addresses)
      && equalResourceValue({ ...before.spec, addresses: undefined }, { ...after.spec, addresses: undefined })
      && equalResourceValue(before.status, after.status)) {
      const removed = [...before.spec.addresses].filter(a => ![...after.spec.addresses].some(ref => ref.uid === a.uid));
      const targets = [...after.spec.addresses].filter(a => ![...before.spec.addresses].some(ref => ref.uid === a.uid));
      const sourceUids = removed.length ? removed.map(a => a.uid) : before.spec.summaryOf?.kind === "Address" ? [before.spec.summaryOf.uid] : [];
      if (sourceUids.length && targets.length <= 1) {
        const candidates = targets.length ? targets : [...after.spec.addresses];
        if (candidates.some(ref => {
          const target = context.get<unknown, { mergeSources?: import("../address/model.ts").AddressRefs }>(ref, ref.uid);
          return sourceUids.every(uid => [...target?.status.mergeSources ?? []].some(source => source.uid === uid));
        })) return;
      }
    }
    if (after.status.writer && (before.spec.text || before.spec.summaryOf) && sensitivityRank(after.spec.sensitivity ?? "L3") < sensitivityRank(before.spec.sensitivity ?? "L3")) throw new Error("Agent cannot lower existing Note sensitivity");
    if (!equalResourceValue(before.spec.subject, after.spec.subject) && (before.spec.sensitivity !== after.spec.sensitivity || before.spec.visibility !== after.spec.visibility)) throw new Error("Move Note separately from classification edits");
    if (before.spec.summaryOf && (!equalResourceValue(before.spec.summaryOf, after.spec.summaryOf)
      || !equalResourceValue(before.spec.subject, after.spec.subject))) throw new Error("Summary Note target is immutable");
    const { reviewTopic: _oldCache, ...oldStatus } = before.status;
    const { reviewTopic: _newCache, ...newStatus } = after.status;
    // Scheduling repairs are independent of the historical content writer's execution.
    if (!equalResourceValue(before.status.reviewTopic, after.status.reviewTopic)
      && equalResourceValue(before.spec, after.spec) && equalResourceValue(oldStatus, newStatus)) return;
    if (!equalResourceValue(before.spec.subject, after.spec.subject)) {
      const writer = after.status.writer;
      if (!writer) throw new Error("Note move requires an execution writer");
      const actor = context.get(writer.resource, writer.resource.uid);
      if (actor?.kind !== "Topic" || !after.status.organization || after.status.organization.reason.trim() === ""
        || !equalResourceValue(after.status.organization.from, before.spec.subject) || !equalResourceValue(after.status.organization.to, after.spec.subject))
        throw new Error("Note move requires an active root Chief and an organization reason");
      const source = context.get(before.spec.subject, before.spec.subject.uid);
      const target = context.get(after.spec.subject, after.spec.subject.uid);
      if (!source || !target) throw new Error("Note move subject no longer exists");
      requireContentWriter(source, writer, context);
      requireOrganization({ actorUid: actor.metadata.uid, executionId: writer.executionId,
        at: after.status.organization.at, reason: after.status.organization.reason }, context,
        [source, target].map(s => s.kind === "Topic" ? requireTopic({ ...s, ...s.metadata }, context)
          : requireTopic((s.status as { topic?: import("@compforge/aide-plugin").ResourceRef }).topic, context)));
      if (before.spec.text !== after.spec.text || !equalResourceValue(before.spec.people, after.spec.people) || before.status.updatedAt !== after.status.updatedAt)
        throw new Error("Move Note separately from content edits");
    }
    if (!equalResourceValue(before.status.reviewed, after.status.reviewed)
      && after.status.reviewed?.version !== noteVersion(after)) throw new Error("Note changed before review");
    validate(after, context);
  }, delete: (note, context) => {
    if (note.spec.summaryOf && context.get(note.spec.summaryOf, note.spec.summaryOf.uid))
      throw new Error("Summary subject still exists");
  } },
  indexes: { summaryOf: r => r.spec.summaryOf ? [r.spec.summaryOf.uid] : [], uid: r => [r.metadata.uid], reviewRoot: r => !r.spec.summaryOf && !r.metadata.deletionTimestamp && r.status.reviewTopic && r.status.reviewed?.version !== noteVersion(r) ? [r.status.reviewTopic.uid] : [], unreviewed: r => !r.spec.summaryOf && !r.metadata.deletionTimestamp && r.status.reviewed?.version !== noteVersion(r) ? [r.spec.subject.uid] : [], subject: r => [r.spec.subject.uid], addresses: r => [...r.spec.addresses].map(a => a.uid), people: r => [...new Set([...r.spec.people].map(p => p.uid))] },
  orderedIndexes: {
    recentSubject: r => r.spec.summaryOf || r.metadata.deletionTimestamp ? [] : [{ value: r.spec.subject.uid, order: r.status.updatedAt }],
    recentAddresses: r => r.metadata.deletionTimestamp ? [] : [...r.spec.addresses].filter(a => a.uid !== r.spec.summaryOf?.uid).map(a => ({ value: a.uid, order: r.status.updatedAt })),
    recentPeople: r => r.spec.summaryOf || r.metadata.deletionTimestamp ? [] : [...new Set([...r.spec.people].map(p => p.uid))].map(value => ({ value, order: r.status.updatedAt })),
  },
  retention: { releasedAt: r => r.status.updatedAt, canEvict: (r, context) => !r.spec.summaryOf || (!context.get(r.spec.summaryOf, r.spec.summaryOf.uid) && ![...r.spec.addresses].some(ref => context.get(ref, ref.uid))), references: () => [] },
  printer: { describe: r => r.spec.text, summarize: r => r.spec.text.slice(0, 200) },
};
