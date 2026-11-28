import { isDeepStrictEqual } from "node:util";
import type { Watch } from "@compforge/aide-plugin";
import type { PluginContext } from "@compforge/aide-plugin";
import { NOTE_TYPE, noteVersion, pendingCuration, noteMaterial, type NoteResource } from "./model.ts";
import { readTopicRoot } from "../topic/tree.ts";
import type { ResourceRef } from "@compforge/aide-plugin";
import { resourceRef } from "../input/state.ts";

const repairAfterMs = 15 * 60_000;

export async function noteRoot(context: Pick<PluginContext, "resources">, note: NoteResource) {
  const subject = await context.resources.get<unknown, { topic?: ResourceRef }>(note.spec.subject);
  if (!subject || subject.metadata.deletionTimestamp) return;
  const ref = subject.kind === "Topic" ? resourceRef(subject) : subject.status.topic;
  if (ref) return readTopicRoot(context.resources, ref);
  const writer = note.status.writer?.resource;
  if (writer?.kind === "Topic") return readTopicRoot(context.resources, writer);
  return undefined;
}
/** @spec Repair the Summary fingerprint or the root index of a draft whose owner moved.
 * @why Ordinary Note edits are evidence changes, not independent review requests.
 * @case tests/note-knowledge.test.ts
 * @link docs/personal/note.md
 */
export async function reconcileNote(context: PluginContext, note: NoteResource) {
  if (note.metadata.deletionTimestamp || note.status.retired) return;
  if (note.spec.summaryOf) {
    const subject = await context.resources.get<unknown, { summaryRevision?: string }>(note.spec.summaryOf);
    if (subject && !subject.metadata.deletionTimestamp && subject.status.summaryRevision !== noteVersion(note)) {
      await context.resources.patchStatus(subject, { summaryRevision: noteVersion(note) });
      context.logger.debug("Summary content observation refreshed", { attributes: { noteUid: note.metadata.uid, subjectUid: subject.metadata.uid } });
    }
    return { requeueAfterMs: repairAfterMs };
  }
  if (pendingCuration(note) && note.status.curationDelivery?.material !== noteMaterial(note.spec)) {
    const root = await noteRoot(context, note);
    if (root && root.metadata.uid !== (note.status.curationRoot ?? note.spec.subject.uid)) {
      await context.resources.patchStatus(note, { curationRoot: root.metadata.uid }, { resourceVersion: note.metadata.resourceVersion });
    }
    return { requeueAfterMs: repairAfterMs };
  }
}

/** @spec Note events wake Topic pressure checks; they never enqueue per-Note review work. */
export function notePressureWatch(context: PluginContext): Watch {
  return { resourceType: NOTE_TYPE, handler: { create: async ({ object }) => requests(object as NoteResource), delete: async ({ object }) => requests(object as NoteResource), update: async ({ oldObject, newObject }) => {
    const a = oldObject as NoteResource, b = newObject as NoteResource;
    if (isDeepStrictEqual(a.status.retired, b.status.retired) && noteVersion(a) === noteVersion(b) && a.status.curationRoot === b.status.curationRoot) return [];
    return [...await requests(a), ...await requests(b)];
  } } };
  async function requests(note: NoteResource) {
    const root = await noteRoot(context, note);
    const subject = note.spec.subject;
    return [...(subject.kind === "Topic" ? [{ name: subject.name, namespace: subject.namespace }] : []),
      ...(root ? [{ name: root.metadata.name, namespace: root.metadata.namespace }] : [])];
  }
}

export function registerNotes(context: PluginContext): void {
  context.controllers.register({ resourceType: NOTE_TYPE, maxConcurrency: 4,
    watches: [{ resourceType: NOTE_TYPE, handler: {
      create: async () => [], delete: async () => [], update: async ({ oldObject, newObject }) => noteVersion(oldObject as NoteResource) !== noteVersion(newObject as NoteResource)
        ? [{ name: newObject.metadata.name, namespace: newObject.metadata.namespace }] : [],
    } }], reconcile: (_execution, note: Readonly<NoteResource>) => reconcileNote(context, note) });
}
