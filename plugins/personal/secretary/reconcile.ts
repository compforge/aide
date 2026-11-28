import { reviewAttention, type InternalCandidate } from "./candidate.ts";
import { selectStow } from "./stow.ts";
import { summaryCandidate } from "./summary.ts";
import { selectOngoing } from "./ongoing.ts";
import { readTopicSubtree } from "../topic/tree.ts";
import { NOTE_TYPE, type NoteResource } from "../note/model.ts";
import { noteCandidate } from "./note.ts";
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
import { maintenanceAgenda, observeCapacity, organizationCandidate } from "./maintenance.ts";
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

/** Rules describe the demand and its age. Only the winning rule reserves its materials. */
export async function listInternalCandidates(context: PluginContext, initial: TopicResource, policy: TopicPolicy, hasReady: boolean) {
  let next = policy.trigger.intervalSeconds * 1000;
  const schedule = idleReviewSchedule(initial, policy.review);
  const topic = Object.keys(schedule.patch).length ? await context.resources.patchStatus(initial, schedule.patch) : initial;
  const candidates: InternalCandidate[] = [];
  const now = Date.now();
  const topics = await readTopicSubtree(context.resources, resourceRef(topic));
  const followup = await selectOngoing(context, topics, policy);
  candidates.push(...followup.candidates);
  next = Math.min(next, followup.requeueAfterMs);
  const pending = await context.resources.page<NoteResource["spec"], NoteResource["status"]>(NOTE_TYPE, {
    matchIndex: { name: "pendingCuration", value: topic.metadata.uid }, direction: "asc", limit: 1 });
  if (pending.items[0]) {
    const result = await noteCandidate(context, pending.items[0], policy, now, topic.metadata.uid);
    if (result?.candidate) candidates.push(result.candidate);
    if (result) next = Math.min(next, result.requeueAfterMs);
  }
  for (const member of topics) {
    const candidate = await organizationCandidate(context, member, policy);
    if (candidate) candidates.push(candidate);
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
    const observed = new Date(now).toISOString();
    const createdAt = [...(weave ? [topic.status.weaveSince ?? observed] : []),
      ...(workloadDue && work.pendingSince ? [work.pendingSince] : []), ...notePressure.map(p => p.pressure.since ?? observed)].sort()[0] ?? observed;
    const attention = reviewAttention(createdAt, policy.review.idleSeconds * 1000, now);
    candidates.push({ attention, createdAt, dispatch: () => tryCreateMaintenanceInput(context, topic, observed, agenda, "aide:curate",
      notePressure.length ? "note_pressure" : weave ? "understanding" : countDue ? "workload" : "idle",
      { plan, instructions: maintenanceInstructions(plan, policy.maxChars), cooldownSeconds: policy.capacityCooldownSeconds }, policy, fingerprint, attention) });
  } else if (due && !candidates.length && !hasReady) {
    const patch = { reviewCheckedAt: new Date().toISOString(), idleReviewReset: null,
      idleReviewCount: policy.review.backoff ? Math.min(Number.MAX_SAFE_INTEGER, schedule.count + 1) : 0 };
    try { await commitStatus(context.resources, [{ operation: "patchStatus", resource: topic, patch }]); }
    catch (error) { if (isResourceVersionConflict(error)) return { candidates, requeueAfterMs: 1 }; throw error; }
    context.logger.debug?.("Secretary review check found no work", { attributes: { topicUid: topic.metadata.uid,
      reason: "no_review_demand", completed: work.completed, reviewed: work.reviewed, idleReviewCount: patch.idleReviewCount,
      nextAt: idleReviewSchedule({ ...topic, status: { ...topic.status, ...patch } }, policy.review).dueAt } });
  }
  const gate = await context.resources.get<TopicResource["spec"], TopicResource["status"]>(topic.spec.parentRef!);
  if (gate) {
    const summary = await summaryCandidate(context, gate, now, topic);
    if (summary.candidate) candidates.push(summary.candidate);
    next = Math.min(next, summary.requeueAfterMs);
  }
  const stow = await selectStow(context, topic, policy);
  if (stow) candidates.push(stow);
  return { requeueAfterMs: next, candidates };
}

/** @spec Deferred aggregation follows material count and oldest arrival even during an active Chief execution.
 * @case tests/input-batch.test.ts
 */
export async function prepareSecretary(context: PluginContext, topic: TopicResource, policy: TopicPolicy) {
  if (topic.metadata.deletionTimestamp) return;
  if (isGateTopic(topic)) return summaryCandidate(context, topic);
  await refreshNotePressure(context, topic);
  // Persist pressure onset even when no domain selection runs during a long Chief invocation.
  await observeCapacity(context, topic, policy);
  if (isRootTopic(topic)) return { requeueAfterMs: await prepareInputs(context, topic, policy) };
  await reconcileBatches(context, topic);
}

export function registerSecretary(context: PluginContext): void {
  const policy = topicPolicy(context.instance.config.topic);
  context.controllers.register({ name: "secretary", resourceType: TOPIC_TYPE, maxConcurrency: 4,
    watches: [batchWatch(), notePressureWatch(context), topicWatch(context), materialWatch(), assignmentWatch("assess", "Topic")],
    reconcile: (_execution, topic: Readonly<TopicResource>) => prepareSecretary(context, topic, policy) });
}
