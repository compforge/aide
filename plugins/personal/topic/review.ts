import { assignInput } from "../input/assignment.ts";
import { commitStatus } from "../status.ts";
import { isDeepStrictEqual } from "node:util";
import type { maintenanceAgenda } from "./maintenance.ts";
import { z } from "zod";
import type { PluginContext } from "@compforge/aide-plugin";
import type { TopicResource, TopicStatus } from "./model.ts";
import type { TopicReviewPolicy } from "./config.ts";
import { INPUT_TYPE, InputAttention, type InputSpec, type InputStatus } from "../input/model.ts";
import { inputRef, resourceRef } from "../input/state.ts";
import { digest } from "../chief-model.ts";

/** Per-Topic opt-in controls background review, independently of Reconcile wakeups and business input. */
export const TopicReviewSchema = z.object({ enabled: z.boolean().default(true) }).strict();
export type TopicReview = z.infer<typeof TopicReviewSchema>;
export const topicReview = (review?: TopicReview): TopicReview => TopicReviewSchema.parse(review ?? {});

export function idleReviewDelay(config: TopicReviewPolicy, count = 0): number {
  return 1000 * (config.backoff
    ? Math.min(config.idleSeconds * config.backoff.factor ** count, config.backoff.maxIdleSeconds)
    : config.idleSeconds);
}

/**
 * @spec Review eligibility derives from durable timing facts and the current policy; periodic Reconcile wakeups have no business deadline.
 * @spec The first observed business arrival resets backoff without postponing an earlier review; later arrivals retain that boundary.
 * @why Keeping the pre-reset count and arrival time lets both deadlines be recalculated after policy changes, without restarting the wait.
 * @case tests/topic-review.test.ts
 * @link docs/personal/topic.md#topic-定时回顾
 */
export function idleReviewSchedule(topic: Readonly<TopicResource>, config: TopicReviewPolicy) {
  const status = topic.status;
  const since = [status.idleSince ?? topic.metadata.creationTimestamp, status.reviewCheckedAt ?? ""].sort().at(-1)!;
  const enabled = !topic.spec.parentRef && !topic.metadata.deletionTimestamp && topicReview(topic.spec.review).enabled;
  let reset = enabled && config.backoff ? status.idleReviewReset ?? null : null;
  if (reset && reset.at <= since) reset = null;
  if (enabled && config.backoff && !reset && status.lastInputAt && status.lastInputAt > since)
    reset = { at: status.lastInputAt, previousCount: status.idleReviewCount ?? 0 };
  const count = enabled && config.backoff && !reset ? status.idleReviewCount ?? 0 : 0;
  const dueAt = new Date(Math.min(Date.parse(since) + idleReviewDelay(config, reset?.previousCount ?? count),
    reset ? Date.parse(reset.at) + config.idleSeconds * 1000 : Infinity)).toISOString();
  const patch: Partial<TopicStatus> = {};
  if ((status.idleReviewCount ?? 0) !== count) patch.idleReviewCount = count;
  if (!isDeepStrictEqual(status.idleReviewReset ?? null, reset)) patch.idleReviewReset = reset;
  return { dueAt, count, patch };
}

/** @spec Internal requests use ordinary Input assignment/admission; origin determines scheduling, text carries the task.
 * @why A Topic CAS and pending-request index prevent duplicate requests across concurrent wakeups and restarts.
 * @link docs/personal/topic.md#树内整理与维护优先级
 */
export async function createReviewInput(context: Pick<PluginContext, "resources" | "logger">, topic: Readonly<TopicResource>, dueAt: string,
  agenda: Awaited<ReturnType<typeof maintenanceAgenda>>, origin: "aide:review" | "aide:triage" | "aide:organize" = "aide:review", notes: Array<{ noteId: string; version: string }> = []) {
  if (topic.metadata.deletionTimestamp || (origin === "aide:review" && (topic.spec.parentRef || topic.status.execution || (!topicReview(topic.spec.review).enabled && !notes.length))))
    throw new Error("Review requires an idle enabled root Topic");
  const pending = await context.resources.listPage<InputSpec, InputStatus>(INPUT_TYPE, {
    matchIndex: { name: "internalPending", value: JSON.stringify([topic.metadata.uid, origin]) }, limit: 1 });
  if (pending.items[0]) return pending.items[0];
  const inputId = `${origin.slice(5)}-${digest([topic.metadata.uid, dueAt])}`;
  const at = new Date().toISOString();
  const target = resourceRef(topic);
  const spec: InputSpec = {
    origin, originId: "personal.topic", originRef: target, topicId: topic.spec.id, attention: InputAttention.Normal,
    text: `${origin === "aide:triage" ? "Triage this Topic's direct unfiled Inputs and Work. Assess unclaimed Inputs when useful; file completed materials into coherent children, creating a child when needed. Never replay admitted or completed assessments." : origin === "aide:organize" ? "Organize this Topic's direct children. Establish meaningful intermediate groups or detach independent subtrees; do not split merely to satisfy a count." : "Review current understanding, unresolved questions and relevant Work; update summaries only when useful."} Target Topic: ${topic.metadata.uid}. Recheck current state before acting. Act within existing authority; this is not a new user request and communication is optional. Work on at most 8 materials or 8 direct children this round, preserve all processing receipts, and record completion with assess_input even if no action remains.\nMatter Notes to review: ${JSON.stringify(notes)}. Read full Notes, consider durable Topic/Person summaries and topic organization, then call review_notes for the versions inspected, including when no durable change is useful.\nFacts: ${JSON.stringify(agenda)}`,
    observation: { dueAt, triggeredAt: at, facts: agenda },
  };
  const status: InputStatus = { topic: target,
    route: { completedAt: at, result: { topics: [target], reason: `Built-in ${origin} request for this Topic` } }, assess: {} };
  await commitStatus(context.resources, [
    { operation: "patchStatus", resource: topic, patch: origin === "aide:review"
      ? { reviewCheckedAt: at, idleReviewCount: 0, idleReviewReset: null }
      : { capacityRequests: { ...topic.status.capacityRequests, [origin]: { checkedAt: at, inputId } } } },
    { operation: "create", type: INPUT_TYPE, name: inputId, spec, status },
  ]);
  const input = (await context.resources.get<InputSpec, InputStatus>(inputRef(inputId)))!;
  await assignInput(context, input);
  context.logger.info("Topic internal Input requested", { attributes: { origin, topicUid: topic.metadata.uid, inputId, dueAt } });
  return (await context.resources.get<InputSpec, InputStatus>(inputRef(inputId)))!;
}
