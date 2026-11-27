import { summaryName, type SummaryResource } from "./summary.ts";
import { INPUT_TYPE } from "../input/model.ts";
import type { InputSpec, InputStatus } from "../input/model.ts";
import { isGateTopic } from "../topic/boundary.ts";
import { equalResourceValue } from "../../../src/resource/value.ts";
import { requireOrganization, requireTopic } from "../topic/ownership.ts";
import { clearCurationSchedule, pendingCuration, noteMaterial, noteVersion, noteMaxChars } from "./model.ts";
import { requireContentWriter } from "../context-write.ts";
import type { ResourceDefinition, ResourceValidationContext } from "@compforge/aide-plugin";
import { NOTE_TYPE, WriterResourceSchema, NoteSpecSchema, NoteStatusSchema, type NoteSpec, type NoteStatus, type NoteResource } from "./model.ts";

/** @spec Chief may capture an unclassified draft; delegated Work and split parts declare their knowledge nature on creation.
 * @spec Note is independent knowledge. summaryOf identifies the subject whose long-lived understanding it holds.
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
  const subject = context.get<unknown, SummaryResource["status"]>(note.spec.subject, note.spec.subject.uid);
  if (!subject || subject.metadata.deletionTimestamp || subject.metadata.name !== note.spec.subject.name || subject.metadata.namespace !== note.spec.subject.namespace) throw new Error("Note subject no longer exists");
  if (subject.kind === "Topic" && isGateTopic(subject as import("../topic/model.ts").TopicResource)) throw new Error("Gate keeps dialogue continuity, not domain Notes");
  if (note.spec.summaryOf && !note.status.retired) {
    if (!equalResourceValue(note.spec.subject, note.spec.summaryOf)) throw new Error("Summary Note subject must match summaryOf");
    const summaries = context.page<NoteSpec, NoteStatus>(NOTE_TYPE, { namespace: "v1", limit: 2,
      matchIndex: { name: "summaryOf", value: note.spec.summaryOf.uid } }).items;
    if (summaries.some(n => n.metadata.uid !== note.metadata.uid)) throw new Error("Subject already has a summary Note");
  }
  if (writer) requireContentWriter(subject, writer, context);
  return subject;
}
/** Scope-relative visibility must still describe the same audience after extraction. */
function validateSplitPart(part: NoteResource, context: ResourceValidationContext) {
  const from = part.status.splitFrom;
  if (!from) return;
  const source = context.get<NoteSpec, NoteStatus>(NOTE_TYPE, from.uid);
  if (!source || source.metadata.deletionTimestamp || source.status.retired || noteVersion(source) !== from.version)
    throw new Error("Split source changed; read the Note again");
  const writer = part.status.writer;
  if (!writer || part.spec.summaryOf || source.spec.sensitivity !== part.spec.sensitivity || source.spec.visibility !== part.spec.visibility
    || !equalResourceValue(source.spec.people, part.spec.people) || !equalResourceValue(source.spec.addresses, part.spec.addresses))
    throw new Error("A split part requires a writer and the source Note's disclosure and associations");
  if (source.spec.subject.uid === part.spec.subject.uid) return;
  const visibility = source.spec.visibility;
  if (visibility !== "topic" && visibility !== "root") return;
  const topicOf = (subject: NoteSpec["subject"]) => requireTopic(subject.kind === "Topic" ? subject
    : context.get<unknown, { topic?: import("@compforge/aide-plugin").ResourceRef }>(subject, subject.uid)?.status.topic, context);
  const topics = [topicOf(source.spec.subject), topicOf(part.spec.subject)];
  if (visibility === "topic" && topics[0]!.metadata.uid !== topics[1]!.metadata.uid)
    throw new Error("Split would change the Note's topic disclosure audience");
  requireOrganization({ actorUid: writer.resource.uid, executionId: writer.executionId, at: part.status.updatedAt, reason: "Split Note" }, context, topics);
}
export const NoteDefinition: ResourceDefinition<NoteSpec, NoteStatus> = {
  type: NOTE_TYPE, indexVersion: 10, schema: { spec: NoteSpecSchema, status: NoteStatusSchema },
  validator: { create: (note, context) => {
    const owner = validate(note, context);
    const chiefDraft = note.status.writer?.resource.kind === "Topic" && !note.status.splitFrom && !!note.spec.text;
    if (!note.spec.summaryOf && !note.spec.nature && !chiefDraft) {
      // prepareSummary reserves the empty Note before publishing its summaryOf and owner revision together.
      if (note.spec.text !== "" || note.metadata.name !== summaryName(owner))
        throw new Error("Creating an ordinary Note requires nature (semantic or procedural)");
    }
    if (note.status.curationDelivery || note.status.curateAt || note.status.curationRetry || note.status.curated || note.status.retired || note.status.pruned) throw new Error("A new Note cannot have reduction receipts");
    validateAddresses(note, context); validateSplitPart(note, context);
  }, update: (before, after, context) => {
    if (!after.spec.summaryOf && !after.spec.nature && (before.spec.nature || (!before.spec.text && after.spec.text)))
      throw new Error("An ordinary Note must retain its nature");
    if (!equalResourceValue(before.status.splitFrom, after.status.splitFrom)) throw new Error("Split provenance is immutable");
    // Secretary schedules the next dispatch independently of the historical content writer.
    if (after.status.curateAt && after.status.curateAt !== before.status.curateAt
      && pendingCuration(before) && equalResourceValue(before.spec, after.spec)
      && equalResourceValue({ ...before.status, curateAt: after.status.curateAt }, after.status)) return;
    const delivery = after.status.curationDelivery;
    if (delivery && !equalResourceValue(before.status.curationDelivery, delivery)) {
      const input = context.get<InputSpec, InputStatus>(INPUT_TYPE, delivery.inputUid);
      const planned = input?.spec.observation?.notes;
      if (!input?.status.assess?.executionId || !input.status.assess.completedAt || input.spec.origin !== "aide:curate"
        || !Array.isArray(planned) || !planned.some(n => n?.noteId === before.metadata.name && n.version === noteVersion(before))
        || delivery.material !== noteMaterial(before.spec) || !equalResourceValue(before.spec, after.spec)
        || !equalResourceValue({ ...before.status, curationDelivery: delivery }, after.status))
        throw new Error("Note delivery requires the delivered curation Input and matching Note version");
      return;
    }
    if (!equalResourceValue(before.status.curationRetry, after.status.curationRetry)) {
      const retry = after.status.curationRetry;
      const input = retry && context.get<InputSpec, InputStatus>(INPUT_TYPE, retry.inputUid);
      const assess = input?.status.assess;
      if (!retry || input?.spec.origin !== "aide:curate" || !assess?.executionId || !assess.completedAt
        || retry.material !== noteMaterial(before.spec) || !equalResourceValue(before.spec, after.spec)
        || !equalResourceValue({ ...before.status, curationRetry: retry }, after.status))
        throw new Error("Curation deferral requires the corresponding assessment");
      const subject = context.get(before.spec.subject, before.spec.subject.uid);
      if (!subject) throw new Error("Note subject no longer exists");
      requireContentWriter(subject, { resource: WriterResourceSchema.parse(input.status.topic), executionId: assess.executionId }, context);
      return;
    }
    if (!equalResourceValue(before.status.curated, after.status.curated)) {
      const receipt = after.status.curated;
      const input = receipt && context.get<InputSpec, InputStatus>(INPUT_TYPE, receipt.inputUid);
      const executionId = input?.status.assess?.executionId;
      if (!input || input.spec.origin !== "aide:curate" || !input.status.assess?.completedAt || !executionId
        || !before.spec.nature || !pendingCuration(before) || receipt.material !== noteMaterial(before.spec)
        || !equalResourceValue(before.spec, after.spec) || !equalResourceValue({ ...before.status, curated: receipt }, after.status))
        throw new Error("Curation receipt requires the assessed Input and the reviewed Note material");
      const subject = context.get(before.spec.subject, before.spec.subject.uid);
      if (!subject) throw new Error("Note subject no longer exists");
      requireContentWriter(subject, { resource: WriterResourceSchema.parse(input.status.topic), executionId }, context);
      return;
    }
    if (!equalResourceValue(before.status.retired, after.status.retired)) {
      if (!after.status.retired || !equalResourceValue(before.spec, after.spec) || before.status.updatedAt !== after.status.updatedAt)
        throw new Error("Retirement must preserve Note content and age");
      if (after.spec.summaryOf) {
        const owner = context.get<unknown, import("../context.ts").ResourceContext>(after.spec.summaryOf, after.spec.summaryOf.uid);
        if (owner && (owner.status.summaryRevision || owner.status.lastRetiredSummaryUid !== before.metadata.uid))
          throw new Error("Retire the Summary and clear its owner revision together");
      }
      const subject = context.get(after.spec.subject, after.spec.subject.uid);
      if (!subject) throw new Error("Note subject no longer exists");
      requireContentWriter(subject, after.status.retired.writer, context);
    }
    if (!equalResourceValue(before.status.pruned, after.status.pruned)) {
      if (!after.status.pruned || !equalResourceValue(after.status.pruned.writer, after.status.writer) || !after.spec.text.trim() || after.spec.text.length >= before.spec.text.length)
        throw new Error("Pruning requires a shorter nonempty body; use retire_note to discard a Note");
      if (!equalResourceValue({ ...before.spec, text: undefined }, { ...after.spec, text: undefined })) throw new Error("Prune content separately from metadata edits");
    }
    if (!equalResourceValue(before.spec.addresses, after.spec.addresses)) validateAddresses(after, context);
    if (!equalResourceValue(before.spec.addresses, after.spec.addresses)
      && equalResourceValue({ ...before.spec, addresses: undefined }, { ...after.spec, addresses: undefined })
      && equalResourceValue(clearCurationSchedule(before.status), clearCurationSchedule(after.status))
      && (!after.status.curateAt || after.status.curateAt === before.status.curateAt)) {
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
    // Address identity repair above also applies to retired evidence; content tools cannot edit it.
    if (before.status.retired && (!equalResourceValue(before.spec, after.spec) || !equalResourceValue(before.status, after.status)))
      throw new Error("Retired Note is immutable");
    if (!equalResourceValue(before.spec.subject, after.spec.subject) && (before.spec.sensitivity !== after.spec.sensitivity || before.spec.visibility !== after.spec.visibility)) throw new Error("Move Note separately from classification edits");
    if (before.spec.summaryOf && (!equalResourceValue(before.spec.summaryOf, after.spec.summaryOf)
      || !equalResourceValue(before.spec.subject, after.spec.subject))) throw new Error("Summary Note target is immutable");
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
    validate(after, context);
  }, delete: (note, context) => {
    if (note.spec.summaryOf && !note.status.retired && context.get(note.spec.summaryOf, note.spec.summaryOf.uid))
      throw new Error("Summary subject still exists");
  } },
  indexes: {
    summaryOf: r => r.spec.summaryOf && !r.status.retired ? [r.spec.summaryOf.uid] : [],
    knownSummary: r => r.spec.summaryOf && !r.metadata.deletionTimestamp && !r.status.retired && r.spec.text.trim() ? [r.spec.summaryOf.uid] : [],
    uid: r => [r.metadata.uid], subject: r => [r.spec.subject.uid], addresses: r => [...r.spec.addresses].map(a => a.uid), people: r => [...new Set([...r.spec.people].map(p => p.uid))] },
  orderedIndexes: {
    pendingCuration: note => {
      const since = pendingCuration(note);
      return since && note.status.curationDelivery?.material !== noteMaterial(note.spec) ? [{ value: note.status.curationRoot ?? note.spec.subject.uid, order: note.status.curateAt && note.status.curateAt > since ? note.status.curateAt : since }] : [];
    },
    offeredCuration: note => note.status.curationDelivery?.material === noteMaterial(note.spec) && pendingCuration(note) && note.status.curateAt
      ? [{ value: note.spec.subject.uid, order: note.status.curateAt }] : [],
    oversizedSubject: r => !r.metadata.deletionTimestamp && !r.status.retired && r.spec.text.length > noteMaxChars(r.spec)
      ? [{ value: r.spec.subject.uid, order: r.metadata.uid }] : [],
    pressureSubject: r => r.spec.summaryOf || r.metadata.deletionTimestamp || r.status.retired ? [] : [{ value: r.spec.subject.uid, order: r.metadata.uid }],
    recentSubject: r => r.spec.summaryOf || r.metadata.deletionTimestamp || r.status.retired ? [] : [{ value: r.spec.subject.uid, order: r.status.updatedAt }],
    recentAddresses: r => r.metadata.deletionTimestamp || r.status.retired ? [] : [...r.spec.addresses].filter(a => a.uid !== r.spec.summaryOf?.uid).map(a => ({ value: a.uid, order: r.status.updatedAt })),
    recentPeople: r => r.spec.summaryOf || r.metadata.deletionTimestamp || r.status.retired ? [] : [...new Set([...r.spec.people].map(p => p.uid))].map(value => ({ value, order: r.status.updatedAt })),
  },
  retention: { releasedAt: r => r.status.updatedAt, canEvict: (r, context) => !r.spec.summaryOf || !!r.status.retired || (!context.get(r.spec.summaryOf, r.spec.summaryOf.uid) && ![...r.spec.addresses].some(ref => context.get(ref, ref.uid))), references: () => [] },
  printer: { describe: r => r.spec.text, summarize: r => r.spec.text.slice(0, 200) },
};
