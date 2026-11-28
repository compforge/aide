import { reviewAttention } from "./candidate.ts";
import type { PluginContext } from "@compforge/aide-plugin";
import { NOTE_TYPE, noteMaterial, noteVersion, pendingCuration, type NoteResource } from "../note/model.ts";
import { noteRoot } from "../note/reconcile.ts";
import { isRootTopic } from "../topic/boundary.ts";
import { type TopicPolicy } from "../topic/config.ts";
import { maintenanceAgenda } from "./maintenance.ts";
import { tryCreateMaintenanceInput } from "./input.ts";
import { digest } from "../identity.ts";

/** @spec Secretary batches changed Note material for curation.
 * @case tests/note-knowledge.test.ts
 * @link docs/personal/note.md
 */
export async function noteCandidate(context: PluginContext, note: NoteResource, policy: TopicPolicy, now = Date.now(), expectedRoot?: string) {
  if (note.metadata.deletionTimestamp || note.status.retired || note.spec.summaryOf) return;
  const since = pendingCuration(note);
  if (!since || note.status.curationDelivery?.material === noteMaterial(note.spec)) return;
  const at = new Date(now).toISOString();
  if (note.status.curateAt && note.status.curateAt > at) return { requeueAfterMs: Date.parse(note.status.curateAt) - now };
  const topic = await noteRoot(context, note);
  if (!topic || expectedRoot && topic.metadata.uid !== expectedRoot || !isRootTopic(topic)) return;
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
  if (due <= now) {
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
    const createdAt = new Date(oldest).toISOString();
    const attention = reviewAttention(createdAt, policy.curation.maxWaitSeconds * 1000, now);
    const dispatch = async () => tryCreateMaintenanceInput(context, topic, at, await maintenanceAgenda(context.resources, [], policy),
      "aide:curate", "notes_changed", { notes: batch, instructions, cooldownSeconds: cooldown }, policy, digest(notes), attention);
    return { candidate: { attention, createdAt, dispatch }, requeueAfterMs: policy.capacityCooldownSeconds * 1000 };
  } else next = due;
  return { requeueAfterMs: Math.min(Math.max(1, next - now), 2_147_483_647) };
}
