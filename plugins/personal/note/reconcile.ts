import { isDeepStrictEqual } from "node:util";
import { SubjectSchema } from "./model.ts";
import { TOPIC_TYPE, type TopicResource } from "../topic/model.ts";
import { WORK_TYPES } from "../resources.ts";
import type { Watch, Resource } from "@compforge/aide-plugin";
import type { PluginContext } from "@compforge/aide-plugin";
import { NOTE_TYPE, noteVersion, type NoteResource } from "./model.ts";
import { readTopicRoot } from "../topic/tree.ts";
import { updateTopic } from "../topic/state.ts";
import type { ResourceRef } from "@compforge/aide-plugin";
import { resourceRef } from "../input/state.ts";

const repairAfterMs = 15 * 60_000;

export async function noteRoot(context: Pick<PluginContext, "resources">, note: NoteResource) {
  const subject = await context.resources.get<unknown, { topic?: ResourceRef }>(note.spec.subject);
  if (!subject || subject.metadata.deletionTimestamp) return;
  const ref = subject.kind === "Topic" ? resourceRef(subject) : subject.status.topic;
  return ref ? readTopicRoot(context.resources, ref) : undefined;
}
/** @spec Note changes eventually enter a bounded root review queue, including Work Notes and root-local Notes.
 * @why Per-Note reconciliation provides fair retry without scanning all Notes or Work on each root wakeup.
 * @case tests/note-knowledge.test.ts
 * @link docs/personal/note.md
 */
export async function reconcileNote(context: PluginContext, note: NoteResource) {
  if (note.metadata.deletionTimestamp || note.status.reviewed?.version === noteVersion(note)) return;
  const root = await noteRoot(context, note);
  if (!root) return { requeueAfterMs: repairAfterMs };
  if (note.status.reviewTopic?.uid !== root.metadata.uid)
    await context.resources.patchStatus(note, { reviewTopic: { ...SubjectSchema.parse(resourceRef(root)), kind: "Topic" } });
  const entry = { noteId: note.metadata.name, version: noteVersion(note) };
  const updated = await updateTopic(context.resources, root, current => {
    const queue = current.status.noteReviewQueue ?? [], existing = queue.find(n => n.noteId === entry.noteId);
    if (existing?.version === entry.version || (!existing && queue.length >= 20)) return {};
    return { noteReviewQueue: [...queue.filter(n => n.noteId !== entry.noteId), entry] };
  });
  if (!updated.status.noteReviewQueue?.some(n => n.noteId === entry.noteId))
    context.logger.debug("Note review waits for queue capacity", { attributes: { noteId: entry.noteId, topicUid: root.metadata.uid } });
  return { requeueAfterMs: repairAfterMs };
}

export async function pendingNoteReviews(context: PluginContext, root: import("../topic/model.ts").TopicResource) {
  const result = [];
  for (const ref of root.status.noteReviewQueue ?? []) {
    const note = await context.resources.get<NoteResource["spec"], NoteResource["status"]>({ ...NOTE_TYPE, namespace: "v1", name: ref.noteId });
    if (!note || note.metadata.deletionTimestamp || note.status.reviewed?.version === noteVersion(note)) continue;
    if ((await noteRoot(context, note))?.metadata.uid === root.metadata.uid) result.push({ noteId: ref.noteId, version: noteVersion(note) });
  }
  return result;
}

/** @spec Watches accelerate dependency changes; periodic per-Note repair covers missed events and ancestor moves. */
export function noteReviewWatch(context: PluginContext): Watch {
  return { resourceType: NOTE_TYPE, handler: { create: async () => [], delete: async ({ object }) => {
    const root = await noteRoot(context, object as NoteResource);
    return root ? [{ name: root.metadata.name, namespace: root.metadata.namespace }] : [];
  }, update: async ({ oldObject, newObject }) => {
    const a = oldObject as NoteResource, b = newObject as NoteResource;
    if (isDeepStrictEqual(a.status.reviewed, b.status.reviewed) && noteVersion(a) === noteVersion(b)) return [];
    const roots = await Promise.all([a, b].map(note => noteRoot(context, note)));
    return roots.flatMap(root => root ? [{ name: root.metadata.name, namespace: root.metadata.namespace }] : []);
  } } };
}
export function registerNotes(context: PluginContext): void {
  const waiting = async (index: string, uid: string) => (await context.resources.page(NOTE_TYPE, {
    limit: 40, matchIndex: { name: index, value: uid },
  })).items.map(note => ({ name: note.metadata.name, namespace: note.metadata.namespace }));
  const dependencyWatch = (resourceType: typeof TOPIC_TYPE | (typeof WORK_TYPES)[number]): Watch => ({ resourceType,
    handler: { create: async () => [], delete: async () => [], update: async ({ oldObject, newObject }) => {
      if (resourceType.kind === "Topic") {
        const a = oldObject as TopicResource, b = newObject as TopicResource;
        const moved = !isDeepStrictEqual(a.spec.parentRef, b.spec.parentRef);
        const freed = (a.status.noteReviewQueue ?? []).some(entry => !(b.status.noteReviewQueue ?? []).some(n => n.noteId === entry.noteId));
        return [...(freed ? await waiting("reviewRoot", b.metadata.uid) : []), ...(moved ? await waiting("unreviewed", b.metadata.uid) : [])];
      }
      const a = oldObject as Resource<unknown, { topic?: ResourceRef }>, b = newObject as typeof a;
      return !isDeepStrictEqual(a.status.topic, b.status.topic) ? waiting("unreviewed", b.metadata.uid) : [];
    } } });
  context.controllers.register({ resourceType: NOTE_TYPE, maxConcurrency: 4,
    watches: [dependencyWatch(TOPIC_TYPE), ...WORK_TYPES.map(dependencyWatch), { resourceType: NOTE_TYPE, handler: {
      create: async () => [], delete: async () => [], update: async ({ oldObject, newObject }) => noteVersion(oldObject as NoteResource) !== noteVersion(newObject as NoteResource)
        ? [{ name: newObject.metadata.name, namespace: newObject.metadata.namespace }] : [],
    } }], reconcile: (_execution, note: Readonly<NoteResource>) => reconcileNote(context, note) });
}
