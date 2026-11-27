import { isResourceVersionConflict, retryOnConflict, type PluginContext } from "@compforge/aide-plugin";
import { noteVersion, type NoteResource } from "../note/model.ts";
import { assignInput } from "../input/assignment.ts";
import { inputStatus } from "../input/conditions.ts";
import { INPUT_TYPE, InputAttention, deliveryFinished, type InputSpec, type InputStatus } from "../input/model.ts";
import { inputRef, resourceRef, type Input } from "../input/state.ts";
import { TOPIC_TYPE, type TopicResource, type TopicStatus } from "../topic/model.ts";
import type { TopicPolicy } from "../topic/config.ts";
import type { maintenanceAgenda } from "./maintenance.ts";
import type { ReviewPreparation } from "./review.ts";
import { chiefWorkload } from "../topic/workload.ts";
import { digest } from "../identity.ts";
import { followupInputId, type OngoingResource } from "../ongoing/model.ts";
class ObsoleteMaintenanceRequest extends Error {}
type MaintenanceOrigin = "aide:curate" | "aide:followup" | "aide:organize";

const maintenanceTask: Record<MaintenanceOrigin, string> = {
  "aide:organize": "Organize the Topic tree and file Inputs, Work and Notes within its scope. Recheck all direct capacity limits. Preserve processing receipts when filing material.",
  "aide:curate": "Review ordinary Notes and Work in this domain. Reconcile knowledge and responsibilities against current evidence.",
  "aide:followup": "Check the Ongoing against current evidence and related Work.",
};

/** @spec Internal requests use ordinary Input assignment/admission; origin determines scheduling, text carries the task.
 * @why Transaction-local eligibility and pending-request uniqueness allow unrelated Topic status writers to proceed.
 * @spec Request creation and its cooldown commit together; retry contains only resource operations.
 * @link docs/personal/secretary.md#容量与维护请求
 */
export async function createMaintenanceInput(context: Pick<PluginContext, "resources" | "logger">, topic: Readonly<TopicResource>, dueAt: string,
  agenda: Awaited<ReturnType<typeof maintenanceAgenda>>, origin: MaintenanceOrigin = "aide:curate", trigger: "capacity" | "idle" | "workload" | "understanding" | "note_pressure" | "notes_changed" | "question_due" | "ongoing_check_due" | "work_input" = "idle", preparation?: { notes?: NoteResource[]; closeoutFor?: string; ongoing?: OngoingResource; materials?: readonly Input[]; plan?: ReviewPreparation; instructions: string; cooldownSeconds: number }, fingerprint = digest(agenda)) {
  if (origin === "aide:followup" && (!preparation?.ongoing || !preparation.materials?.length && !followupInputId(preparation.ongoing))) throw new ObsoleteMaintenanceRequest();
  const target = resourceRef(topic);
  const maintenance = preparation?.plan, instructions = preparation?.instructions ?? "";
  const input = await retryOnConflict(async () => {
    const current = await context.resources.get<TopicResource["spec"], TopicResource["status"]>(target);
    if (preparation?.ongoing && origin === "aide:followup") {
      const fresh = await context.resources.get<OngoingResource["spec"], OngoingResource["status"]>(resourceRef(preparation.ongoing));
      if (!fresh || fresh.metadata.resourceVersion !== preparation.ongoing.metadata.resourceVersion) throw new ObsoleteMaintenanceRequest();
    }
    if (!current || current.metadata.deletionTimestamp) throw new Error("Maintenance Topic no longer exists");
    if (preparation?.closeoutFor && (current.status.closeoutFor === preparation.closeoutFor ||
      (current.status.lastInputAt ?? current.metadata.creationTimestamp) !== preparation.closeoutFor)) throw new ObsoleteMaintenanceRequest();
    const pending = await context.resources.page<InputSpec, InputStatus>(INPUT_TYPE, {
      matchIndex: { name: "internalPending", value: JSON.stringify([topic.metadata.uid, origin]) }, limit: 1 });
    if (pending.items[0]) return pending.items[0];
    const scheduledMatter = origin === "aide:followup" ? preparation?.ongoing : undefined;
    const materials = preparation?.materials ?? [];
    const consumesCheck = scheduledMatter && !scheduledMatter.status.followupInputId && dueAt === scheduledMatter.status.nextCheckAt;
    const requestKey = [topic.metadata.uid, dueAt];
    if (preparation?.notes) requestKey.push(fingerprint);
    const inputId = scheduledMatter ? (consumesCheck ? followupInputId(scheduledMatter)! : fingerprint) : `${origin.slice(5)}-${digest(requestKey)}`;
    const at = new Date().toISOString();
    const spec: InputSpec = {
      origin, originId: "personal.topic", originRef: target, topicId: topic.spec.id, attention: InputAttention.Normal,
      text: `${maintenanceTask[origin]} Target Topic: ${topic.metadata.uid}. Recheck current state before acting. Act within existing authority; this is not a new user request; ${origin === "aide:followup" ? "Ask Me privately if a consequential fact is still missing." : origin === "aide:curate" ? "Maintain existing mandates. Base new Work on the original business Input or source Note or Work. Keep this review silent." : "Do not communicate or hand off business Work."} Work on at most 8 materials or 8 direct children this round.\nFacts: ${JSON.stringify(agenda)}\n${instructions}`,
      observation: { ...(preparation?.notes ? { notes: preparation.notes.map(note => ({ noteId: note.metadata.name, version: noteVersion(note) })) } : {}), ...(scheduledMatter ? { ongoingId: scheduledMatter.metadata.name, ongoingUid: scheduledMatter.metadata.uid, question: scheduledMatter.spec.question ?? null, ...(materials.length ? { inputIds: materials.map(i => i.metadata.name) } : {}) } : {}), dueAt, triggeredAt: at, facts: agenda, trigger, ...(origin === "aide:curate" && !preparation?.notes ? { review: {
        completed: chiefWorkload(current).completed, weaveRevision: maintenance?.weaveRevision ?? 0,
        pressure: (maintenance?.notePressure ?? []).map(({ uid, pressure }) => ({ uid, version: pressure.version })),
      } } : {}) },
    };
    const status: InputStatus = { topic: target,
      route: { completedAt: at, result: { topics: [target], reason: `Built-in ${origin} request for this Topic` } }, assess: {} };
    const noteWrites = [];
    if (preparation?.notes) {
      const curateAt = new Date(Math.max(Date.parse(dueAt), Date.parse(at)) + preparation.cooldownSeconds * 1000).toISOString();
      for (const note of preparation.notes) {
        noteWrites.push({ operation: "patchStatus" as const, resource: note,
          options: { resourceVersion: note.metadata.resourceVersion }, patch: { curateAt } });
      }
    }
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
      ...materials.map(material => ({ operation: "patchStatus" as const, resource: material, options: { resourceVersion: material.metadata.resourceVersion },
        patch: { ...inputStatus({ ...material.status, handle: { ...material.status.handle, [scheduledMatter!.metadata.uid]: {
          ...material.status.handle![scheduledMatter!.metadata.uid]!, completedAt: at, result: { summary: "Attached material submitted to Chief", disposition: "completed" },
        } } }) } })),
      ...(scheduledMatter ? [{ operation: "patchStatus" as const, resource: scheduledMatter, patch: consumesCheck ? { followupInputId: inputId } : {},
        options: { resourceVersion: scheduledMatter.metadata.resourceVersion } }] : []),
      ...noteWrites,
      ...pressureWrites,
      { operation: "patchStatus", resource: current, options: { resourceVersion: current.metadata.resourceVersion }, patch: {
        ...(preparation?.closeoutFor ? { closeoutFor: preparation.closeoutFor } : {}),
        ...(ownerPressure ? { notePressure: ownerPressure } : {}),
        maintenanceRequests: { [origin]: { checkedAt: at, inputId, fingerprint,
          attempts: current.status.maintenanceRequests?.[origin]?.fingerprint === fingerprint
            ? Math.min(14, (current.status.maintenanceRequests[origin]?.attempts ?? 0) + 1) : 1 } },
        ...(origin === "aide:curate" && !preparation?.notes ? { reviewCheckedAt: at, idleReviewReset: null,
          chiefWorkload: { ...chiefWorkload(current), requestedThrough: chiefWorkload(current).completed, afterRequestSince: null } } : {}),
      } },
    ]); } catch (error) {
      // Reconcile again from the ordered Note index if another writer won the dispatch.
      if (preparation?.notes && isResourceVersionConflict(error)) {
        context.logger.debug?.("Note dispatch superseded by a concurrent change", { attributes: { topicUid: topic.metadata.uid, fingerprint } });
        throw new ObsoleteMaintenanceRequest();
      }
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

/** Pending requests stay single-flight. Newly attached material can wake Chief after the prior delivery settles. */
export async function tryCreateMaintenanceInput(context: Pick<PluginContext, "resources" | "logger">, topic: Readonly<TopicResource>, dueAt: string,
  agenda: Awaited<ReturnType<typeof maintenanceAgenda>>, origin: MaintenanceOrigin, trigger: Parameters<typeof createMaintenanceInput>[5],
  preparation: Parameters<typeof createMaintenanceInput>[6], policy: TopicPolicy, fingerprint: string) {
  const current = await context.resources.get<TopicResource["spec"], TopicResource["status"]>(resourceRef(topic));
  if (!current || current.metadata.deletionTimestamp) return;
  const previous = current.status.maintenanceRequests?.[origin];
  if (previous) {
    const input = await context.resources.get<InputSpec, InputStatus>(inputRef(previous.inputId));
    if (input && !deliveryFinished(input.status.assess)) return;
    const attempts = previous.fingerprint === fingerprint ? previous.attempts : 0;
    // Fourteen attempts reach the cap even with a one-second base cooldown.
    const delay = Math.min(Math.max(7200, policy.capacityCooldownSeconds), policy.capacityCooldownSeconds * 2 ** Math.max(0, attempts - 1));
    const nextAt = Date.parse(input?.status.assess?.completedAt ?? previous.checkedAt) + delay * 1000;
    if (!preparation?.notes && !preparation?.materials?.length && Date.now() < nextAt) {
      context.logger.debug?.("Secretary maintenance cooling down", { attributes: { topicUid: topic.metadata.uid, origin,
        reason: attempts ? "unchanged_need" : "minimum_cooldown", attempts, nextAt: new Date(nextAt).toISOString() } });
      return;
    }
  }
  try { return await createMaintenanceInput(context, current, dueAt, agenda, origin, trigger, preparation, fingerprint); }
  catch (error) {
    if (error instanceof ObsoleteMaintenanceRequest || String(error).includes("Chief is dormant")) return;
    if (!String(error).includes("Resource capacity exhausted")) throw error;
    context.logger.warn("Topic maintenance deferred at resource capacity", { attributes: { topicUid: topic.metadata.uid, origin, error: String(error) } });
  }
}
