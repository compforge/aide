import { inWorkWindow } from "../topic/activity.ts";
import { selectStow } from "./stow.ts";
import { checkSummary } from "./summary.ts";
import { selectOngoing } from "./ongoing.ts";
import { readTopicSubtree } from "../topic/tree.ts";
import { preparedIntake, type PreparedIntake } from "./intake.ts";
import { NOTE_TYPE, type NoteResource } from "../note/model.ts";
import { prepareNoteMaintenance } from "./note.ts";
import { topicWatch, materialWatch } from "../topic/watch.ts";
import { notePressureWatch } from "../note/reconcile.ts";
import { digest } from "../identity.ts";
import { chiefWorkload } from "../topic/workload.ts";
import { tryCreateMaintenanceInput } from "./input.ts";
import { isResourceVersionConflict, type PluginContext } from "@compforge/aide-plugin";
import { batchWatch, reconcileBatches } from "../batch/reconcile.ts";
import { prepareInputs } from "./batching.ts";
import { assignmentWatch, resourceRef } from "../input/state.ts";
import { dueNotePressure, refreshNotePressure } from "../note/pressure.ts";
import { commitStatus } from "../status.ts";
import { isGateTopic, isRootTopic } from "../topic/boundary.ts";
import { topicPolicy, type TopicPolicy } from "../topic/config.ts";
import { maintenanceAgenda, ensureOrganizationInput } from "./maintenance.ts";
import type { ReviewPreparation } from "./review.ts";
import { TOPIC_TYPE, type TopicResource } from "../topic/model.ts";
import { idleReviewSchedule } from "./review.ts";
import { topicReview } from "../topic/review.ts";

function maintenanceInstructions(plan: ReviewPreparation, maxChars: number): string {
  return [
    "Inspect list_work for related or superseded responsibilities. Start from Work when its outcome or scope calls for revisiting a Note or another Work.",
    plan.weaveRevision ? "Topic structure changed. Inspect current Topic structure and preserve responsibility boundaries." : "",
    plan.notePressure.length ? `Note consolidation (reason: note_pressure): ${JSON.stringify(plan.notePressure.map(({ uid, pressure: p }) => ({ uid, maxNotes: p.maxNotes, count: p.count, oversized: p.oversized.slice(0, 3).map(n => n.noteId), moreOversized: p.oversized.length > 3 })))}. Counts are lower bounds. Page list_notes by each subject and read complete Notes. Budgets are soft limits, not deletion targets. Merge compatible matters, use split_note for mixed material and move misplaced Notes. Follow subject, people and addresses to locate related ordinary Notes. Confirm destination writes before pruning sources; preserve evidence, uncertainty, unresolved work and disclosure. Inspect at most 8 Notes per Topic.` : "",
    `Topic summary budget: ${maxChars}. Preparation is a snapshot; recheck current evidence before writing.`,
  ].filter(Boolean).join("\n");
}

/** @spec The serial root reconcile selects one dispatch from live CRDs, then admits that selection.
 * @link docs/personal/secretary.md#reconciler
 * @case tests/topic-secretary.test.ts
 */
export async function reconcileSecretary(context: PluginContext, initial: Readonly<TopicResource>, policy: TopicPolicy = topicPolicy(context.instance.config.topic)):
    Promise<{ requeueAfterMs: number; intake?: PreparedIntake }> {
  let next = policy.trigger.intervalSeconds * 1000;
  let topic = await context.resources.get<TopicResource["spec"], TopicResource["status"]>(resourceRef(initial));
  if (!topic || topic.metadata.deletionTimestamp || topic.status.execution || !isRootTopic(topic)) return { requeueAfterMs: next };
  const open = inWorkWindow(topic, policy);
  const schedule = idleReviewSchedule(topic, policy.review);
  if (open && Object.keys(schedule.patch).length) topic = await context.resources.patchStatus(topic, schedule.patch);
  const ready = await preparedIntake(context.resources, topic, !open, next);
  if (ready.inputs.length) return { intake: ready, requeueAfterMs: next };
  if (!open) return { requeueAfterMs: next };
  const topics = await readTopicSubtree(context.resources, resourceRef(topic));
  const followup = await selectOngoing(context, topics, policy);
  next = Math.min(next, followup.requeueAfterMs);
  if (followup.input) return { intake: { inputs: [followup.input] }, requeueAfterMs: next };
  const pending = await context.resources.page<NoteResource["spec"], NoteResource["status"]>(NOTE_TYPE, {
    matchIndex: { name: "pendingCuration", value: topic.metadata.uid }, direction: "asc", limit: 1 });
  if (pending.items[0]) {
    const result = await prepareNoteMaintenance(context, pending.items[0], policy, Date.now(), topic.metadata.uid);
    if (result?.input) return { intake: { inputs: [result.input] }, requeueAfterMs: next };
    if (result) next = Math.min(next, result.requeueAfterMs);
  }
  for (const member of topics) {
    const input = await ensureOrganizationInput(context, member, policy);
    if (input) return { intake: { inputs: [input] }, requeueAfterMs: next };
  }
  const due = topicReview(topic.spec.review).enabled && Date.parse(schedule.dueAt) <= Date.now();
  const notePressure = await dueNotePressure(context.resources, topic, Date.now(), Math.max(1, Math.min(8, Math.floor((policy.contextChars - 3000) / 600))));
  const work = chiefWorkload(topic);
  const countDue = work.completed - work.reviewed >= policy.review.completedInputs;
  const timeDue = !!work.pendingSince && Date.parse(work.pendingSince) + policy.review.idleSeconds * 1000 <= Date.now();
  const workloadDue = topicReview(topic.spec.review).enabled && (countDue || timeDue);
  const weave = (topic.status.weaveRevision ?? 0) > (topic.status.notifiedWeaveRevision ?? 0);
  if (workloadDue || weave || notePressure.length) {
    const plan: ReviewPreparation = { weaveRevision: topic.status.weaveRevision ?? 0, notePressure };
    const agenda = await maintenanceAgenda(context.resources, [], policy);
    if (notePressure.length) agenda.reason = "note_pressure";
    const fingerprint = digest([weave ? plan.weaveRevision : 0,
      notePressure.map(entry => [entry.uid, entry.pressure.version]), workloadDue ? work.completed : null]);
    const input = await tryCreateMaintenanceInput(context, topic, new Date().toISOString(), agenda, "aide:curate",
      notePressure.length ? "note_pressure" : weave ? "understanding" : countDue ? "workload" : "idle",
      { plan, instructions: maintenanceInstructions(plan, policy.maxChars), cooldownSeconds: policy.capacityCooldownSeconds }, policy, fingerprint);
    if (input) return { intake: { inputs: [input] }, requeueAfterMs: next };
  } else if (due && !topic.status.execution) {
    const patch = { reviewCheckedAt: new Date().toISOString(), idleReviewReset: null,
      idleReviewCount: policy.review.backoff ? Math.min(Number.MAX_SAFE_INTEGER, schedule.count + 1) : 0 };
    try { await commitStatus(context.resources, [{ operation: "patchStatus", resource: topic, patch }]); }
    catch (error) { if (isResourceVersionConflict(error)) return { requeueAfterMs: 1 }; throw error; }
    context.logger.debug?.("Secretary review check found no work", { attributes: { topicUid: topic.metadata.uid,
      reason: "no_review_demand", completed: work.completed, reviewed: work.reviewed, idleReviewCount: patch.idleReviewCount,
      nextAt: idleReviewSchedule({ ...topic, status: { ...topic.status, ...patch } }, policy.review).dueAt } });
  }
  const gate = await context.resources.get<TopicResource["spec"], TopicResource["status"]>(topic.spec.parentRef!);
  if (gate) {
    const summary = await checkSummary(context, gate, Date.now(), topic, policy);
    if (summary.input) return { intake: { inputs: [summary.input] }, requeueAfterMs: next };
    next = Math.min(next, summary.requeueAfterMs);
  }
  const stow = await selectStow(context, topic, policy);
  return { requeueAfterMs: next, intake: stow ? { inputs: [stow] } : undefined };
}

/** @spec Deferred aggregation follows material count and oldest arrival even during an active Chief execution.
 * @case tests/input-batch.test.ts
 */
export async function prepareSecretary(context: PluginContext, topic: TopicResource, policy: TopicPolicy) {
  if (topic.metadata.deletionTimestamp) return;
  if (isGateTopic(topic)) return checkSummary(context, topic, Date.now(), undefined, policy);
  await refreshNotePressure(context, topic);
  if (isRootTopic(topic)) return { requeueAfterMs: await prepareInputs(context, topic, policy) };
  await reconcileBatches(context, topic);
}

export function registerSecretary(context: PluginContext): void {
  const policy = topicPolicy(context.instance.config.topic);
  context.controllers.register({ name: "secretary", resourceType: TOPIC_TYPE, maxConcurrency: 4,
    watches: [batchWatch(), notePressureWatch(context), topicWatch(context), materialWatch(), assignmentWatch("assess", "Topic")],
    reconcile: (_execution, topic: Readonly<TopicResource>) => prepareSecretary(context, topic, policy) });
}
