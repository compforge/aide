import type { PluginContext } from "@compforge/aide-plugin";
import { NOTE_TYPE, noteMaterial, noteVersion, pendingCuration, type NoteResource } from "../note/model.ts";
import { noteRoot } from "../note/reconcile.ts";
import { TOPIC_TYPE, type TopicResource } from "../topic/model.ts";
import { isRootTopic } from "../topic/boundary.ts";
import { topicPolicy, type TopicPolicy } from "../topic/config.ts";
import { maintenanceAgenda } from "./maintenance.ts";
import { tryCreateMaintenanceInput } from "./input.ts";
import { digest } from "../identity.ts";

/** @spec Secretary batches changed Note material for curation.
 * @case tests/note-knowledge.test.ts
 * @link docs/personal/note.md
 */
export async function prepareNoteMaintenance(context: PluginContext, note: NoteResource, policy: TopicPolicy, now = Date.now(), closeout = false) {
  if (note.metadata.deletionTimestamp || note.status.retired || note.spec.summaryOf) return;
  const since = pendingCuration(note);
  if (!since || note.status.curationDelivery?.material === noteMaterial(note.spec)) return;
  const at = new Date(now).toISOString();
  if (note.status.curateAt && note.status.curateAt > at) return { requeueAfterMs: Date.parse(note.status.curateAt) - now };
  const topic = await noteRoot(context, note);
  if (!topic || !isRootTopic(topic) || topic.status.phase === "dormant") return;
  const activity = topic.status.lastInputAt ?? topic.metadata.creationTimestamp;
  closeout ||= now >= Date.parse(activity) + policy.dormantAfterSeconds * 1000;
  if (closeout && topic.status.closeoutFor === activity) return;
  // Give an unchanged Note a full curation window before it can consume another Chief turn.
  const cooldown = Math.max(policy.capacityCooldownSeconds, policy.curation.maxWaitSeconds);
  let next: number;
  const { items } = await context.resources.page<NoteResource["spec"], NoteResource["status"]>(NOTE_TYPE, {
    matchIndex: { name: "pendingCuration", value: topic.metadata.uid }, limit: 8, direction: "asc" });
  // A Work or subtree may have moved since the last Note write. Recheck ownership before sharing its ID.
  const eligible = items.filter(item => !item.status.curateAt || item.status.curateAt <= at);
  const roots = await Promise.all(eligible.map(item => noteRoot(context, item)));
  const batch = eligible.filter((_, i) => roots[i]?.metadata.uid === topic.metadata.uid);
  if (batch.length < 8 && !batch.some(item => item.metadata.uid === note.metadata.uid)) batch.push(note);
  const oldest = Math.min(...batch.map(item => Date.parse(pendingCuration(item)!)));
  const due = batch.length >= policy.curation.count ? now : oldest + policy.curation.maxWaitSeconds * 1000;
  if (closeout || due <= now) {
    if (batch.length < 8) {
      const offered = await context.resources.page<NoteResource["spec"], NoteResource["status"]>(NOTE_TYPE, {
        matchIndex: { name: "offeredCuration", value: note.spec.subject.uid }, limit: 8 - batch.length, direction: "asc" });
      for (const prior of offered.items) {
        if (prior.status.curateAt! > at) break;
        if ((await noteRoot(context, prior))?.metadata.uid === topic.metadata.uid) batch.push(prior);
      }
    }
    const notes = batch.map(item => ({ noteId: item.metadata.name, version: noteVersion(item) }));
    const instructions = `Start with these changed ordinary Notes, then look for related evidence and duplicates: ${notes.map(item => item.noteId).join(", ")}.`;
    await tryCreateMaintenanceInput(context, topic, at, await maintenanceAgenda(context.resources, [], policy),
      "aide:curate", "notes_changed", { notes: batch, instructions, cooldownSeconds: cooldown, ...(closeout ? { closeoutFor: activity } : {}) }, policy, digest(notes));
    next = now + policy.capacityCooldownSeconds * 1000;
  } else next = due;
  return { requeueAfterMs: Math.min(Math.max(1, next - now), 2_147_483_647) };
}

export function registerNoteMaintenance(context: PluginContext) {
  const policy = topicPolicy(context.instance.config.topic);
  const wakePending = async (uid: string) => {
    const pending = await context.resources.page<NoteResource["spec"], NoteResource["status"]>(NOTE_TYPE, {
      matchIndex: { name: "pendingCuration", value: uid }, direction: "asc", limit: 1 });
    return pending.items.map(note => ({ name: note.metadata.name, namespace: note.metadata.namespace }));
  };
  context.controllers.register({ name: "secretary-notes", resourceType: NOTE_TYPE, maxConcurrency: 4,
    watches: [{ resourceType: TOPIC_TYPE, handler: { create: async () => [], delete: async () => [],
      update: async ({ oldObject, newObject }) => {
        const before = oldObject as TopicResource, after = newObject as TopicResource;
        return isRootTopic(after) && after.status.phase === "active" && (before.status.phase === "dormant"
          || !!before.status.execution && !after.status.execution) ? wakePending(after.metadata.uid) : [];
      } } }],
    reconcile: (_execution, note: NoteResource) => prepareNoteMaintenance(context, note, policy) });
}
