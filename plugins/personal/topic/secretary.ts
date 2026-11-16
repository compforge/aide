import { isResourceVersionConflict, type PluginContext } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { prepareInputs } from "../input/batch.ts";
import { resourceRef } from "../input/state.ts";
import { readNotes } from "../note/query.ts";
import { dueNotePressure, recordNotePressure, refreshNotePressure } from "../note/pressure.ts";
import { commitStatus } from "../status.ts";
import { isGateTopic, isProcessingRoot } from "./boundary.ts";
import { topicPolicy, type TopicPolicy } from "./config.ts";
import { maintenanceAgenda, ensureCapacityInputs } from "./maintenance.ts";
import type { MaintenancePlan } from "./maintenance-plan.ts";
import { TOPIC_TYPE, type TopicResource } from "./model.ts";
import { idleReviewSchedule, topicReview, reviewMaterialVersion, tryCreateReviewInput } from "./review.ts";
import { readTopicSubtree, understandingVersion, pendingAbsorption } from "./tree.ts";

function maintenanceInstructions(plan: MaintenancePlan, maxChars: number): string {
  return [
    plan.weaveRevision ? "Topic structure changed. Inspect current Topic structure and preserve responsibility boundaries." : "",
    plan.absorption.length ? `Knowledge maintenance: review changed children bottom-up; confirm absorbed versions even when summaries need no edit. Pending versions: ${JSON.stringify(plan.absorption)}.` : "",
    plan.notePressure.length ? `Note consolidation (reason: note_pressure): ${JSON.stringify(plan.notePressure.map(({ uid, pressure: p }) => ({ uid, maxNotes: p.maxNotes, count: p.count, oversized: p.oversized.slice(0, 3).map(n => n.noteId), moreOversized: p.oversized.length > 3 })))}. Counts are lower bounds. Page list_notes by each subject and read complete Notes. Budgets are soft limits, not deletion targets. Merge compatible matters and move misplaced Notes. Follow subject, people and addresses to update durable Topic/Person/Address summaries when useful. Confirm destination writes before pruning sources; preserve evidence, uncertainty, unresolved work and disclosure. Inspect at most 8 Notes per Topic. Leave unfinished maintenance pending; otherwise assess_input even if no safe reduction is useful.` : "",
    `Topic summary budget: ${maxChars}. Preparation is a snapshot; recheck current evidence before writing.`,
  ].filter(Boolean).join("\n");
}

/** @spec Receipt-driven preparation outcomes survive a crash after Agent execution.
 * @spec Confirm only the prepared material version, never concurrent new material.
 */
async function settleMaintenance(context: PluginContext, topic: TopicResource, policy: TopicPolicy) {
  if (topic.status.execution) return topic;
  const outcomes = await context.resources.page<InputSpec, InputStatus>(INPUT_TYPE, {
    matchIndex: { name: "maintenanceOutcome", value: topic.metadata.uid }, limit: 20 });
  for (const input of outcomes.items) {
    const plan = input.spec.maintenance!, acknowledged = !!input.status.assess?.completedAt && !["cancelled", "rejected"].includes(input.status.assess.result?.disposition ?? "");
    const all = await readTopicSubtree(context.resources, resourceRef(topic));
    const versions = new Map(await Promise.all(all.map(async t => [t.metadata.uid,
      understandingVersion(t, await readNotes(context.resources, t.metadata.uid, "subject"))] as const)));
    const remaining = pendingAbsorption(all, topic, true, versions);
    const absorbed = plan.absorption.some(before => !remaining.some(after => after.uid === before.uid && after.version === before.version));
    const progressed = reviewMaterialVersion(all, versions) !== plan.materialVersion;
    if (acknowledged && plan.notePressure.length) await recordNotePressure(context.resources, plan.notePressure, policy.capacityCooldownSeconds, input.status.assess?.executionId);
    const current = (await context.resources.get<TopicResource["spec"], TopicResource["status"]>(resourceRef(topic)))!;
    if (current.status.execution) return current;
    const at = new Date().toISOString();
    await commitStatus(context.resources, [
      { operation: "patchStatus", resource: current, patch: {
        ...(absorbed ? { absorbAttempts: 0, nextAbsorbAt: new Date(Date.now() + 60_000).toISOString() } : {}),
        ...(acknowledged ? { reviewedMaterialVersion: plan.materialVersion, notifiedWeaveRevision: Math.max(current.status.notifiedWeaveRevision ?? 0, plan.weaveRevision) } : {}),
        ...(progressed || (current.status.lastInputAt ?? "") > (plan.lastInputAt ?? "") ? { idleReviewCount: 0 }
          : acknowledged ? { idleReviewCount: policy.review.backoff ? Math.min(Number.MAX_SAFE_INTEGER, (current.status.idleReviewCount ?? 0) + 1) : 0 } : {}),
      } },
      { operation: "patchStatus", resource: input, patch: { preparationSettledAt: at } },
    ]);
    topic = (await context.resources.get<TopicResource["spec"], TopicResource["status"]>(resourceRef(topic)))!;
    context.logger.info("Secretary maintenance outcome recorded", { attributes: { topicUid: topic.metadata.uid, inputId: input.metadata.name,
      acknowledged, progressed, pendingChildren: remaining.length, idleReviewCount: topic.status.idleReviewCount ?? 0 } });
  }
  return topic;
}

async function cancelObsolete(context: PluginContext, topic: TopicResource, policy: TopicPolicy) {
  for (const origin of ["aide:review", "aide:triage", "aide:organize"] as const) {
    const pending = await context.resources.page<InputSpec, InputStatus>(INPUT_TYPE, {
      matchIndex: { name: "internalPending", value: JSON.stringify([topic.metadata.uid, origin]) }, limit: 1 });
    const input = pending.items[0];
    if (!input || input.status.assess?.executionId) continue;
    let obsolete = origin === "aide:review" && (!isProcessingRoot(topic) || Array.isArray(input.spec.observation?.notes)
      || (input.spec.originId === "personal.topic" && !input.spec.maintenance && input.spec.observation?.trigger === "note_pressure"));
    if (origin === "aide:review" && input.spec.maintenance?.notePressure.length
      && !input.spec.maintenance.absorption.length && input.spec.maintenance.weaveRevision <= (topic.status.notifiedWeaveRevision ?? 0)) {
      const targets = await Promise.all(input.spec.maintenance.notePressure.map(entry => context.resources.page<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE,
        { matchIndex: { name: "uid", value: entry.uid }, limit: 1 })));
      obsolete ||= targets.every(page => !page.items[0]?.status.notePressure);
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

/** @spec Secretary prepares work and follows receipts using resource facts only; it never invokes Harness or admits an execution.
 * @why Chief must remain responsive while deterministic count/age and maintenance checks run independently.
 * @case tests/topic-secretary.test.ts
 * @link docs/personal/topic.md#secretary
 */
export async function reconcileSecretary(context: PluginContext, initial: Readonly<TopicResource>, policy: TopicPolicy = topicPolicy(context.instance.config.topic)) {
  if (initial.metadata.deletionTimestamp) return;
  let topic = initial;
  const next = isProcessingRoot(topic) ? await prepareInputs(context, topic, policy) : policy.trigger.intervalSeconds * 1000;
  if (isGateTopic(topic)) return { requeueAfterMs: next };
  await refreshNotePressure(context, topic);
  await cancelObsolete(context, topic, policy);
  await ensureCapacityInputs(context, topic);
  if (!isProcessingRoot(topic)) return { requeueAfterMs: next };
  topic = await settleMaintenance(context, (await context.resources.get<TopicResource["spec"], TopicResource["status"]>(resourceRef(topic)))!, policy);
  const schedule = idleReviewSchedule(topic, policy.review);
  if (Object.keys(schedule.patch).length) topic = await context.resources.patchStatus(topic, schedule.patch);
  const due = topicReview(topic.spec.review).enabled && Date.parse(schedule.dueAt) <= Date.now();
  const outstanding = await context.resources.page<InputSpec, InputStatus>(INPUT_TYPE, {
    matchIndex: { name: "internalPending", value: JSON.stringify([topic.metadata.uid, "aide:review"]) }, limit: 1 });
  if (outstanding.items.length) return { requeueAfterMs: next };
  const notePressure = await dueNotePressure(context.resources, topic, Date.now(), Math.max(1, Math.min(8, Math.floor((policy.contextChars - 3000) / 600))));
  const maintenanceDue = Date.parse(topic.status.nextAbsorbAt ?? "1970-01-01") <= Date.now();
  const weave = (topic.status.weaveRevision ?? 0) > (topic.status.notifiedWeaveRevision ?? 0) && maintenanceDue;
  if (!due && !weave && !notePressure.length) {
    const children = await context.resources.page<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE,
      { matchIndex: { name: "liveParent", value: topic.metadata.uid }, limit: 20 });
    if (!pendingAbsorption([topic, ...children.items], topic, false, new Map()).length) return { requeueAfterMs: next };
  }
  const topics = await readTopicSubtree(context.resources, resourceRef(topic));
  const versions = new Map(await Promise.all(topics.map(async t => [t.metadata.uid,
    understandingVersion(t, await readNotes(context.resources, t.metadata.uid, "subject"))] as const)));
  const materialVersion = reviewMaterialVersion(topics, versions), unchanged = topic.status.reviewedMaterialVersion === materialVersion;
  const absorption = pendingAbsorption(topics, topic, due, versions);
  const absorb = !unchanged && absorption.length > 0 && (due || maintenanceDue);
  if (absorb || weave || notePressure.length) {
    const plan: MaintenancePlan = { materialVersion, lastInputAt: topic.status.lastInputAt, weaveRevision: topic.status.weaveRevision ?? 0,
      absorption: pendingAbsorption(topics, topic, true, versions).slice(0, 20), notePressure };
    const agenda = await maintenanceAgenda(context.resources, [], policy);
    if (notePressure.length) agenda.reason = "note_pressure";
    await tryCreateReviewInput(context, topic, due ? schedule.dueAt : new Date().toISOString(), agenda,
      "aide:review", notePressure.length ? "note_pressure" : due ? "idle" : "understanding", { plan, instructions: maintenanceInstructions(plan, policy.maxChars), cooldownSeconds: policy.capacityCooldownSeconds });
  } else if (due && !topic.status.execution) {
    const patch = { reviewCheckedAt: new Date().toISOString(), idleReviewReset: null,
      idleReviewCount: policy.review.backoff ? Math.min(Number.MAX_SAFE_INTEGER, schedule.count + 1) : 0 };
    try { await commitStatus(context.resources, [{ operation: "patchStatus", resource: topic, patch }]); }
    catch (error) { if (isResourceVersionConflict(error)) return { requeueAfterMs: 1 }; throw error; }
    context.logger.info("Topic review deferred without inference", { attributes: { topicUid: topic.metadata.uid,
      reason: unchanged ? "unchanged_review_material" : "no_pending_material_or_maintenance", idleReviewCount: patch.idleReviewCount,
      dueAt: idleReviewSchedule({ ...topic, status: { ...topic.status, ...patch } }, policy.review).dueAt } });
  }
  return { requeueAfterMs: next };
}
