import type { PluginContext } from "@compforge/aide-plugin";
import { NOTE_TYPE, followupInputId, noteVersion, pendingCuration, type NoteResource } from "../note/model.ts";
import { noteRoot } from "../note/reconcile.ts";
import { isRootTopic } from "../topic/boundary.ts";
import { topicPolicy, type TopicPolicy } from "../topic/config.ts";
import { maintenanceAgenda } from "./maintenance.ts";
import { tryCreateMaintenanceInput } from "./input.ts";
import { digest } from "../identity.ts";

/** @spec Batch changed ordinary Notes by their current root. A scheduled question has its own deadline and receipt.
 * @link docs/personal/note.md
 */
export async function prepareNoteMaintenance(context: PluginContext, note: NoteResource, policy: TopicPolicy, now = Date.now()) {
  if (note.metadata.deletionTimestamp || note.status.retired || note.spec.summaryOf) return;
  const since = pendingCuration(note);
  const followup = note.spec.followup;
  const requestId = followupInputId(note);
  const checkAt = followup && requestId && requestId !== note.status.followupInputId ? Date.parse(followup.checkAt) : Infinity;
  if (!since && !Number.isFinite(checkAt)) return;
  const topic = await noteRoot(context, note);
  if (!topic || !isRootTopic(topic)) return;
  let next = checkAt;
  const cooldown = policy.capacityCooldownSeconds;
  if (followup && requestId && checkAt <= now) {
    const instructions = `Check Note ${note.metadata.name}. Scheduled question: ${followup.question}. Read the current Note, related Work and any new evidence to determine the outcome.`;
    await tryCreateMaintenanceInput(context, topic, followup.checkAt, await maintenanceAgenda(context.resources, [], policy),
      "aide:followup", "question_due", { note, instructions, cooldownSeconds: cooldown }, policy, requestId);
    next = now + cooldown * 1000;
  }
  if (since) {
    const { items } = await context.resources.page<NoteResource["spec"], NoteResource["status"]>(NOTE_TYPE, {
      matchIndex: { name: "pendingCuration", value: topic.metadata.uid }, limit: 8, direction: "asc" });
    // A Work or subtree may have moved since the last Note write. Recheck ownership before sharing its ID.
    const roots = await Promise.all(items.map(item => noteRoot(context, item)));
    const batch = items.filter((_, i) => roots[i]?.metadata.uid === topic.metadata.uid);
    if (batch.length < 8 && !batch.some(item => item.metadata.uid === note.metadata.uid)) batch.push(note);
    const oldest = Math.min(...batch.map(item => Date.parse(pendingCuration(item)!)));
    const due = batch.length >= policy.curation.count ? now : oldest + policy.curation.maxWaitSeconds * 1000;
    if (due <= now) {
      const notes = batch.map(item => ({ noteId: item.metadata.name, version: noteVersion(item) }));
      const instructions = `Start with these changed ordinary Notes, then look for related evidence and duplicates: ${notes.map(item => item.noteId).join(", ")}.`;
      await tryCreateMaintenanceInput(context, topic, new Date(now).toISOString(), await maintenanceAgenda(context.resources, [], policy),
        "aide:curate", "notes_changed", { notes, instructions, cooldownSeconds: cooldown }, policy, digest(notes));
      next = Math.min(next, now + cooldown * 1000);
    } else next = Math.min(next, due);
  }
  return { requeueAfterMs: Math.min(Math.max(1, next - now), 2_147_483_647) };
}

export function registerNoteMaintenance(context: PluginContext) {
  const policy = topicPolicy(context.instance.config.topic);
  context.controllers.register({ name: "secretary-notes", resourceType: NOTE_TYPE, maxConcurrency: 4,
    reconcile: (_execution, note: NoteResource) => prepareNoteMaintenance(context, note, policy) });
}
