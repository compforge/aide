import type { PluginContext } from "@compforge/aide-plugin";
import { NOTE_TYPE, noteVersion, type NoteResource } from "./model.ts";
import { readTopicRoot } from "../topic/tree.ts";
import { updateTopic } from "../topic/state.ts";
import type { ResourceRef } from "@compforge/aide-plugin";
import { resourceRef } from "../input/state.ts";

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
  if (!root) return;
  const entry = { noteId: note.metadata.name, version: noteVersion(note) };
  const updated = await updateTopic(context.resources, root, current => {
    const queue = current.status.noteReviewQueue ?? [], existing = queue.find(n => n.noteId === entry.noteId);
    if (existing?.version === entry.version || (!existing && queue.length >= 20)) return {};
    return { noteReviewQueue: [...queue.filter(n => n.noteId !== entry.noteId), entry] };
  });
  if (!updated.status.noteReviewQueue?.some(n => n.noteId === entry.noteId))
    context.logger.debug("Note review waits for queue capacity", { attributes: { noteId: entry.noteId, topicUid: root.metadata.uid } });
  return { requeueAfterMs: 60_000 };
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

export function registerNotes(context: PluginContext): void {
  context.controllers.register({ resourceType: NOTE_TYPE, maxConcurrency: 4, reconcile: (_execution, note: Readonly<NoteResource>) => reconcileNote(context, note) });
}
