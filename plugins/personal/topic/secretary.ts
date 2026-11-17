import { digest } from "../chief-model.ts";
import { chiefWorkload } from "./workload.ts";
import { tryCreateMaintenanceInput } from "./maintenance-input.ts";
import { isResourceVersionConflict, type PluginContext } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { prepareInputs, reconcileBatches } from "../batch/reconcile.ts";
import { resourceRef } from "../input/state.ts";
import { readNotes } from "../note/query.ts";
import { dueNotePressure, refreshNotePressure } from "../note/pressure.ts";
import { commitStatus } from "../status.ts";
import { isGateTopic, isProcessingRoot } from "./boundary.ts";
import { topicPolicy, type TopicPolicy } from "./config.ts";
import { maintenanceAgenda, ensureCapacityInputs } from "./maintenance.ts";
import { reviewEvidence } from "./review-evidence.ts";
import type { ReviewPreparation } from "./review.ts";
import { TOPIC_TYPE, type TopicResource } from "./model.ts";
import { idleReviewSchedule, topicReview } from "./review.ts";
import { readTopicSubtree, understandingVersion, pendingAbsorption } from "./tree.ts";

function maintenanceInstructions(plan: ReviewPreparation, maxChars: number): string {
  return [
    plan.weaveRevision ? "Topic structure changed. Inspect current Topic structure and preserve responsibility boundaries." : "",
    plan.absorption.length ? `Knowledge maintenance: review changed children bottom-up; confirm absorbed versions even when summaries need no edit. Pending versions: ${JSON.stringify(plan.absorption)}.` : "",
    plan.notePressure.length ? `Note consolidation (reason: note_pressure): ${JSON.stringify(plan.notePressure.map(({ uid, pressure: p }) => ({ uid, maxNotes: p.maxNotes, count: p.count, oversized: p.oversized.slice(0, 3).map(n => n.noteId), moreOversized: p.oversized.length > 3 })))}. Counts are lower bounds. Page list_notes by each subject and read complete Notes. Budgets are soft limits, not deletion targets. Merge compatible matters and move misplaced Notes. Follow subject, people and addresses to update durable Topic/Person/Address summaries when useful. Confirm destination writes before pruning sources; preserve evidence, uncertainty, unresolved work and disclosure. Inspect at most 8 Notes per Topic. Leave unfinished maintenance pending; otherwise assess_input even if no safe reduction is useful.` : "",
    `Topic summary budget: ${maxChars}. Preparation is a snapshot; recheck current evidence before writing.`,
  ].filter(Boolean).join("\n");
}

async function cancelObsolete(context: PluginContext, topic: TopicResource, policy: TopicPolicy) {
  for (const origin of ["aide:review", "aide:triage", "aide:organize"] as const) {
    const pending = await context.resources.page<InputSpec, InputStatus>(INPUT_TYPE, {
      matchIndex: { name: "internalPending", value: JSON.stringify([topic.metadata.uid, origin]) }, limit: 1 });
    const input = pending.items[0];
    if (!input || input.status.assess?.executionId) continue;
    let obsolete = origin === "aide:review" && !isProcessingRoot(topic);
    const evidence = reviewEvidence(input.spec);
    const work = chiefWorkload(topic);
    const workloadDue = topicReview(topic.spec.review).enabled && (work.completed - work.reviewed >= policy.review.completedInputs
      || !!work.pendingSince && Date.parse(work.pendingSince) + policy.review.idleSeconds * 1000 <= Date.now());
    if (evidence?.pressure.length && !workloadDue && evidence.weaveRevision <= (topic.status.notifiedWeaveRevision ?? 0)) {
      const all = await readTopicSubtree(context.resources, resourceRef(topic));
      if (!pendingAbsorption(all, topic).length) {
        const targets = await Promise.all(evidence.pressure.map(entry => context.resources.page<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE,
          { matchIndex: { name: "uid", value: entry.uid }, limit: 1 })));
        obsolete ||= targets.every(page => !page.items[0]?.status.notePressure);
      }
    }
    if (origin !== "aide:review") {
      const facts = (await maintenanceAgenda(context.resources, [topic], policy)).topics[0];
      obsolete = !facts || (origin === "aide:triage" ? facts.inputs <= policy.maxUnfiledInput && facts.work <= policy.maxWork : facts.children <= policy.maxChildren);
    }
    if (!obsolete) continue;
    await commitStatus(context.resources, [{ operation: "patchStatus", resource: input, patch: { assess: { ...input.status.assess,
      completedAt: new Date().toISOString(), result: { summary: "Prepared maintenance no longer needed", disposition: "cancelled" } } } }]);
    context.logger.info("Secretary obsolete Input cancelled", { attributes: { topicUid: topic.metadata.uid, inputId: input.metadata.name } });
  }
}

/** @spec Secretary prepares work using resource facts only; it never invokes Harness or admits an execution.
 * @why Chief must remain responsive while deterministic count/age and maintenance checks run independently.
 * @case tests/topic-secretary.test.ts
 * @link docs/personal/topic.md#secretary
 */
export async function reconcileSecretary(context: PluginContext, initial: Readonly<TopicResource>, policy: TopicPolicy = topicPolicy(context.instance.config.topic)) {
  if (initial.metadata.deletionTimestamp) return;
  let topic = initial;
  if (!isProcessingRoot(topic)) await reconcileBatches(context, topic);
  const next = isProcessingRoot(topic) ? await prepareInputs(context, topic, policy) : policy.trigger.intervalSeconds * 1000;
  if (isGateTopic(topic)) return { requeueAfterMs: next };
  await refreshNotePressure(context, topic);
  await cancelObsolete(context, topic, policy);
  await ensureCapacityInputs(context, topic);
  if (!isProcessingRoot(topic)) return { requeueAfterMs: next };
  topic = (await context.resources.get<TopicResource["spec"], TopicResource["status"]>(resourceRef(topic)))!;
  const schedule = idleReviewSchedule(topic, policy.review);
  if (Object.keys(schedule.patch).length) topic = await context.resources.patchStatus(topic, schedule.patch);
  const due = topicReview(topic.spec.review).enabled && Date.parse(schedule.dueAt) <= Date.now();
  const outstanding = await context.resources.page<InputSpec, InputStatus>(INPUT_TYPE, {
    matchIndex: { name: "internalPending", value: JSON.stringify([topic.metadata.uid, "aide:review"]) }, limit: 1 });
  if (outstanding.items.length) return { requeueAfterMs: next };
  const notePressure = await dueNotePressure(context.resources, topic, Date.now(), Math.max(1, Math.min(8, Math.floor((policy.contextChars - 3000) / 600))));
  const work = chiefWorkload(topic);
  const countDue = work.completed - work.reviewed >= policy.review.completedInputs;
  const timeDue = !!work.pendingSince && Date.parse(work.pendingSince) + policy.review.idleSeconds * 1000 <= Date.now();
  const workloadDue = topicReview(topic.spec.review).enabled && (countDue || timeDue);
  const weave = (topic.status.weaveRevision ?? 0) > (topic.status.notifiedWeaveRevision ?? 0);
  // Summary dependencies are scheduling facts; full Note versions remain write-safety facts.
  const children = await context.resources.page<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE,
    { matchIndex: { name: "liveParent", value: topic.metadata.uid }, limit: 20 });
  const inspectTree = due || topic.status.conditions?.some(c => c.type === "SummaryCurrent" && c.status === "False");
  const inspected = inspectTree ? await readTopicSubtree(context.resources, resourceRef(topic)) : [topic, ...children.items];
  const summaryPending = pendingAbsorption(inspected, topic);
  if (workloadDue || weave || notePressure.length || summaryPending.length) {
    const topics = inspectTree ? inspected : await readTopicSubtree(context.resources, resourceRef(topic));
    const versions = new Map(await Promise.all(topics.map(async t => [t.metadata.uid,
      understandingVersion(t, await readNotes(context.resources, t.metadata.uid, "subject"))] as const)));
    const plan: ReviewPreparation = { weaveRevision: topic.status.weaveRevision ?? 0,
      absorption: pendingAbsorption(topics, topic, true, versions).slice(0, 20), notePressure };
    const agenda = await maintenanceAgenda(context.resources, [], policy);
    if (notePressure.length) agenda.reason = "note_pressure";
    const fingerprint = digest([weave ? plan.weaveRevision : 0,
      pendingAbsorption(topics, topic).map(entry => [entry.uid, entry.parentUid, entry.version]),
      notePressure.map(entry => [entry.uid, entry.pressure.version]), workloadDue ? work.completed : null]);
    await tryCreateMaintenanceInput(context, topic, new Date().toISOString(), agenda, "aide:review",
      notePressure.length ? "note_pressure" : weave || summaryPending.length ? "understanding" : countDue ? "workload" : "idle",
      { plan, instructions: maintenanceInstructions(plan, policy.maxChars), cooldownSeconds: policy.capacityCooldownSeconds }, policy, fingerprint);
  } else if (due && !topic.status.execution) {
    const patch = { reviewCheckedAt: new Date().toISOString(), idleReviewReset: null,
      idleReviewCount: policy.review.backoff ? Math.min(Number.MAX_SAFE_INTEGER, schedule.count + 1) : 0 };
    try { await commitStatus(context.resources, [{ operation: "patchStatus", resource: topic, patch }]); }
    catch (error) { if (isResourceVersionConflict(error)) return { requeueAfterMs: 1 }; throw error; }
    context.logger.debug?.("Secretary review check found no work", { attributes: { topicUid: topic.metadata.uid,
      reason: "no_review_demand", completed: work.completed, reviewed: work.reviewed, idleReviewCount: patch.idleReviewCount,
      nextAt: idleReviewSchedule({ ...topic, status: { ...topic.status, ...patch } }, policy.review).dueAt } });
  }
  return { requeueAfterMs: next };
}
