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

/**
 * @spec An idle review is born routed to its root, with normal attention and no new authority.
 * @why Recording the decision and creating its Input atomically prevents duplicate reviews; the Topic version fences regrouping and concurrent execution.
 * @spec Timer Inputs do not refresh lastInputAt, so periodic reflection cannot keep a quiet Topic alive forever.
 * @case tests/topic-review.test.ts
 * @link docs/personal/topic.md#topic-定时回顾
 */
export async function createReviewInput(context: Pick<PluginContext, "resources" | "logger">, topic: Readonly<TopicResource>, dueAt: string, agenda: Awaited<ReturnType<typeof maintenanceAgenda>>) {
  if (topic.spec.parentRef || topic.metadata.deletionTimestamp || topic.status.execution || !topicReview(topic.spec.review).enabled)
    throw new Error("Idle review requires an enabled, idle root Topic");
  const inputId = `topic-review-${digest([topic.metadata.uid, dueAt])}`;
  const at = new Date().toISOString();
  const idleSince = topic.status.idleSince ?? topic.metadata.creationTimestamp;
  const target = resourceRef(topic);
  const spec: InputSpec = {
    origin: "trigger", originId: "personal.topic-review", originRef: target, topicId: topic.spec.id, attention: InputAttention.Normal,
    text: `${agenda.reason === "organize_material" ? "Review direct Input and Work ownership. Create meaningful children and move materials where useful; assess admitted Inputs before moving them." : agenda.reason === "organize_children" ? "Review child organization. Regroup children or detach a coherent independent subtree when justified; a count alone does not justify splitting." : "Review current understanding, unresolved questions and relevant Work; update summaries only when useful."} Scheduled review at ${at}. Act within existing authorization; this is not a new user request and communication is optional. Record the review with assess_input, including when nothing needs action.\nMaintenance facts: ${JSON.stringify(agenda)}`,
    observation: { dueAt, triggeredAt: at, idleSince, maintenance: agenda },
  };
  const status: InputStatus = {
    topic: target,
    route: { completedAt: at, result: { topics: [target], reason: "Scheduled review of this root Topic" } },
    assess: {},
  };
  await commitStatus(context.resources, [
    { operation: "patchStatus", resource: topic, patch: { reviewCheckedAt: at, idleReviewCount: 0, idleReviewReset: null } },
    { operation: "create", type: INPUT_TYPE, name: inputId, spec, status },
  ]);
  context.logger.info("Chief idle review requested", { attributes: { topicUid: topic.metadata.uid, inputId, dueAt, idleSince, reason: agenda.reason } });
  return (await context.resources.get<InputSpec, InputStatus>(inputRef(inputId)))!;
}
