import type { PluginContext } from "@compforge/aide-plugin";
import { NOTE_TYPE, followupInputId, type NoteResource } from "../note/model.ts";
import { noteRoot } from "../note/reconcile.ts";
import { isRootTopic } from "../topic/boundary.ts";
import { topicPolicy, type TopicPolicy } from "../topic/config.ts";
import { maintenanceAgenda } from "./maintenance.ts";
import { tryCreateMaintenanceInput } from "./input.ts";
import { digest } from "../identity.ts";

/** @spec Secretary schedules the evidenced question once per check time. Silence alone only triggers classification.
 * @link docs/personal/note.md
 */
export async function prepareNoteMaintenance(context: PluginContext, note: NoteResource, policy: TopicPolicy, now = Date.now()) {
  if (note.metadata.deletionTimestamp || note.status.retired || note.spec.summaryOf) return;
  const followup = note.spec.followup;
  const requestId = followupInputId(note);
  const pendingCheck = followup && requestId && requestId !== note.status.followupInputId;
  const curateAt = note.spec.summaryConflict ? now : note.spec.nature ? Infinity
    : Date.parse(note.metadata.creationTimestamp) + policy.unclassifiedAfterSeconds * 1000;
  const checkAt = pendingCheck ? Date.parse(followup.checkAt) : Infinity;
  const due = Math.min(curateAt, checkAt);
  if (!Number.isFinite(due)) return;
  if (due > now) return { requeueAfterMs: Math.min(due - now + 1, 2_147_483_647) };
  const topic = await noteRoot(context, note);
  if (!topic || !isRootTopic(topic)) return;
  const agenda = await maintenanceAgenda(context.resources, [], policy);
  const preparation = { cooldownSeconds: policy.capacityCooldownSeconds, instructions: "", note };
  if (pendingCheck && checkAt <= now) {
    preparation.instructions = `Check Note ${note.metadata.name}. Scheduled question: ${followup.question}. Read the current Note, related Work and new evidence. If the need has changed or Work is following it, finish silently.`;
    await tryCreateMaintenanceInput(context, topic, followup.checkAt, agenda, "aide:followup", "question_due", preparation, policy, requestId);
  } else {
    const page = await context.resources.page<NoteResource["spec"], NoteResource["status"]>(NOTE_TYPE, {
      matchIndex: { name: "curationSubject", value: note.spec.subject.uid }, limit: 8, direction: "asc" });
    const ids = page.items.map(item => item.metadata.name);
    if (!ids.length) return;
    preparation.instructions = `Read these ordinary Notes. Assign missing nature, verify summaryConflict against evidence, correct or narrow existing summaries, then clear resolved flags with summaryConflict=null: ${JSON.stringify(ids)}.`;
    await tryCreateMaintenanceInput(context, topic, new Date().toISOString(), agenda, "aide:curate", note.spec.summaryConflict ? "summary_conflict" : "unclassified", preparation, policy, digest(ids));
  }
  return { requeueAfterMs: policy.capacityCooldownSeconds * 1000 };
}

export function registerNoteMaintenance(context: PluginContext) {
  const policy = topicPolicy(context.instance.config.topic);
  context.controllers.register({ name: "secretary-notes", resourceType: NOTE_TYPE, maxConcurrency: 4,
    reconcile: (_execution, note: NoteResource) => prepareNoteMaintenance(context, note, policy) });
}
