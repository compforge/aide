import { retryOnConflict, type PluginContext } from "@compforge/aide-plugin";
import { assignInput } from "../input/assignment.ts";
import { inputStatus } from "../input/conditions.ts";
import { INPUT_TYPE, InputAttention, assessmentFinished, type InputSpec, type InputStatus } from "../input/model.ts";
import { inputRef, resourceRef } from "../input/state.ts";
import { TOPIC_TYPE, type TopicResource, type TopicStatus } from "../topic/model.ts";
import type { TopicPolicy } from "../topic/config.ts";
import type { maintenanceAgenda } from "./maintenance.ts";
import type { ReviewPreparation } from "./review.ts";
import { chiefWorkload } from "../topic/workload.ts";
import { digest } from "../identity.ts";
import { followupInputId, type NoteResource } from "../note/model.ts";
class ObsoleteNoteRequest extends Error {}
type MaintenanceOrigin = "aide:curate" | "aide:followup" | "aide:organize";

const maintenanceTask: Record<MaintenanceOrigin, string> = {
  "aide:organize": "Organize the Topic tree and file Inputs, Work and Notes within its scope. Recheck all direct capacity limits. Preserve processing receipts when filing material.",
  "aide:curate": "Curate ordinary Notes and durable understanding. Classify and consolidate related material, verify closure, and correct summaries only where warranted.",
  "aide:followup": "Verify the scheduled question against current evidence and related Work.",
};

/** @spec Internal requests use ordinary Input assignment/admission; origin determines scheduling, text carries the task.
 * @why Transaction-local eligibility and pending-request uniqueness allow unrelated Topic status writers to proceed.
 * @spec Request creation and its cooldown commit together; retry contains only resource operations.
 * @link docs/personal/secretary.md#容量与维护请求
 */
export async function createMaintenanceInput(context: Pick<PluginContext, "resources" | "logger">, topic: Readonly<TopicResource>, dueAt: string,
  agenda: Awaited<ReturnType<typeof maintenanceAgenda>>, origin: MaintenanceOrigin = "aide:curate", trigger: "capacity" | "idle" | "workload" | "understanding" | "note_pressure" | "notes_changed" | "question_due" = "idle", preparation?: { notes?: { noteId: string; version: string }[]; note?: NoteResource; plan?: ReviewPreparation; instructions: string; cooldownSeconds: number }, fingerprint = digest(agenda)) {
  const target = resourceRef(topic);
  const maintenance = preparation?.plan, instructions = preparation?.instructions ?? "";
  const input = await retryOnConflict(async () => {
    const current = await context.resources.get<TopicResource["spec"], TopicResource["status"]>(target);
    if (preparation?.note && origin === "aide:followup") {
      const fresh = await context.resources.get<NoteResource["spec"], NoteResource["status"]>(resourceRef(preparation.note));
      if (!fresh || fresh.metadata.resourceVersion !== preparation.note.metadata.resourceVersion) throw new ObsoleteNoteRequest();
    }
    if (!current || current.metadata.deletionTimestamp) throw new Error("Maintenance Topic no longer exists");
    const pending = await context.resources.page<InputSpec, InputStatus>(INPUT_TYPE, {
      matchIndex: { name: "internalPending", value: JSON.stringify([topic.metadata.uid, origin]) }, limit: 1 });
    if (pending.items[0]) return pending.items[0];
    const scheduledNote = origin === "aide:followup" ? preparation?.note : undefined;
    const inputId = scheduledNote ? followupInputId(scheduledNote)! : `${origin.slice(5)}-${digest([topic.metadata.uid, dueAt])}`;
    const at = new Date().toISOString();
    const spec: InputSpec = {
      origin, originId: "personal.topic", originRef: target, topicId: topic.spec.id, attention: InputAttention.Normal,
      text: `${maintenanceTask[origin]} Target Topic: ${topic.metadata.uid}. Recheck current state before acting. Act within existing authority; this is not a new user request; ${origin === "aide:followup" ? "If the current evidence leaves the scheduled question unanswered, ask Me privately." : "Do not communicate or hand off business Work."} Work on at most 8 materials or 8 direct children this round, preserve all processing receipts, and record completion with assess_input even if no action remains.\nFacts: ${JSON.stringify(agenda)}\n${instructions}`,
      observation: { ...(preparation?.notes ? { notes: preparation.notes } : {}), ...(scheduledNote ? { noteId: scheduledNote.metadata.name, noteUid: scheduledNote.metadata.uid } : {}), dueAt, triggeredAt: at, facts: agenda, trigger, ...(origin === "aide:curate" && !preparation?.notes ? { review: {
        completed: chiefWorkload(current).completed, weaveRevision: maintenance?.weaveRevision ?? 0,
        pressure: (maintenance?.notePressure ?? []).map(({ uid, pressure }) => ({ uid, version: pressure.version })),
      } } : {}) },
    };
    const status: InputStatus = { topic: target,
      route: { completedAt: at, result: { topics: [target], reason: `Built-in ${origin} request for this Topic` } }, assess: {} };
    const pressureWrites = [];
    let ownerPressure: TopicStatus["notePressure"];
    for (const entry of maintenance?.notePressure ?? []) {
      const target = (await context.resources.page<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE,
        { matchIndex: { name: "uid", value: entry.uid }, limit: 1 })).items[0];
      if (!target?.status.notePressure) continue;
      const p = target.status.notePressure;
      const notePressure = { ...p,
        attempts: Math.min(5, p.attempts + 1), nextAt: new Date(Date.now() + Math.max(preparation!.cooldownSeconds,
          Math.min(900, preparation!.cooldownSeconds * 2 ** p.attempts)) * 1000).toISOString(),
      };
      if (target.metadata.uid === current.metadata.uid) ownerPressure = notePressure;
      else pressureWrites.push({ operation: "patchStatus" as const, resource: target, patch: { notePressure },
        options: { resourceVersion: target.metadata.resourceVersion } });
    }
    try { await context.resources.commit([
      { operation: "create", type: INPUT_TYPE, name: inputId, spec, status: inputStatus(status) },
      ...(scheduledNote ? [{ operation: "patchStatus" as const, resource: scheduledNote, patch: { followupInputId: inputId },
        options: { resourceVersion: scheduledNote.metadata.resourceVersion } }] : []),
      ...pressureWrites,
      { operation: "patchStatus", resource: current, options: { resourceVersion: current.metadata.resourceVersion }, patch: {
        ...(ownerPressure ? { notePressure: ownerPressure } : {}),
        maintenanceRequests: { [origin]: { checkedAt: at, inputId, fingerprint,
          attempts: current.status.maintenanceRequests?.[origin]?.fingerprint === fingerprint
            ? Math.min(14, (current.status.maintenanceRequests[origin]?.attempts ?? 0) + 1) : 1 } },
        ...(origin === "aide:curate" && !preparation?.notes ? { reviewCheckedAt: at, idleReviewReset: null,
          chiefWorkload: { ...chiefWorkload(current), requestedThrough: chiefWorkload(current).completed, afterRequestSince: null } } : {}),
      } },
    ]); } catch (error) {
      if (typeof error !== "object" || error === null || !("name" in error) || error.name !== "ResourceAlreadyExists") throw error;
      const existing = await context.resources.get<InputSpec, InputStatus>(inputRef(inputId));
      if (!existing || existing.metadata.deletionTimestamp || existing.spec.origin !== origin || existing.status.topic?.uid !== target.uid) throw error;
      return existing;
    }
    context.logger.info("Topic internal Input requested", { attributes: { origin, topicUid: topic.metadata.uid, inputId, dueAt, trigger, fingerprint, completed: chiefWorkload(current).completed } });
    return (await context.resources.get<InputSpec, InputStatus>(inputRef(inputId)))!;
  });
  await assignInput(context, input);
  return (await context.resources.get<InputSpec, InputStatus>(resourceRef(input)))!;
}

/** Secretary applies the same pending/cooldown policy to every maintenance origin. */
export async function tryCreateMaintenanceInput(context: Pick<PluginContext, "resources" | "logger">, topic: Readonly<TopicResource>, dueAt: string,
  agenda: Awaited<ReturnType<typeof maintenanceAgenda>>, origin: MaintenanceOrigin, trigger: Parameters<typeof createMaintenanceInput>[5],
  preparation: Parameters<typeof createMaintenanceInput>[6], policy: TopicPolicy, fingerprint: string) {
  const current = await context.resources.get<TopicResource["spec"], TopicResource["status"]>(resourceRef(topic));
  if (!current || current.metadata.deletionTimestamp) return;
  const previous = current.status.maintenanceRequests?.[origin];
  if (previous) {
    const input = await context.resources.get<InputSpec, InputStatus>(inputRef(previous.inputId));
    if (input && !assessmentFinished(input.status.assess)) return;
    const attempts = previous.fingerprint === fingerprint ? previous.attempts : 0;
    // Fourteen attempts reach the cap even with a one-second base cooldown.
    const delay = Math.min(Math.max(7200, policy.capacityCooldownSeconds), policy.capacityCooldownSeconds * 2 ** Math.max(0, attempts - 1));
    const nextAt = Date.parse(input?.status.assess?.completedAt ?? previous.checkedAt) + delay * 1000;
    if (Date.now() < nextAt) {
      context.logger.debug?.("Secretary maintenance cooling down", { attributes: { topicUid: topic.metadata.uid, origin,
        reason: attempts ? "unchanged_need" : "minimum_cooldown", attempts, nextAt: new Date(nextAt).toISOString() } });
      return;
    }
  }
  try { return await createMaintenanceInput(context, current, dueAt, agenda, origin, trigger, preparation, fingerprint); }
  catch (error) {
    if (error instanceof ObsoleteNoteRequest) return;
    if (!String(error).includes("Resource capacity exhausted")) throw error;
    context.logger.warn("Topic maintenance deferred at resource capacity", { attributes: { topicUid: topic.metadata.uid, origin, error: String(error) } });
  }
}
