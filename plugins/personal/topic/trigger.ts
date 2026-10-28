import { commitStatus } from "../status.ts";
import type { maintenanceAgenda } from "./maintenance.ts";
import { z } from "zod";
import type { PluginContext } from "@compforge/aide-plugin";
import type { TopicResource, TopicStatus } from "./model.ts";
import { ChiefTriggerConfigSchema, type ChiefTriggerConfig } from "../../../agents/chief/config.ts";
import { readTopicSubtree } from "./tree.ts";
import { INPUT_TYPE, InputAttention, type InputSpec, type InputStatus } from "../input/model.ts";
import { inputRef, pendingInputs, resourceRef, type Input } from "../input/state.ts";
import { digest } from "../chief-model.ts";

/** Root Topics opt into Chief idle reviews; cadence belongs to Chief configuration. */
export const TopicTriggerSchema = z.object({ enabled: z.boolean().default(true) }).strict();
export type TopicTrigger = z.infer<typeof TopicTriggerSchema>;
export const topicTrigger = (trigger?: TopicTrigger): TopicTrigger => TopicTriggerSchema.parse(trigger ?? {});

export function idleReviewDelay(config: ChiefTriggerConfig, count = 0): number {
  return 1000 * (config.backoff
    ? Math.min(config.idleSeconds * config.backoff.factor ** count, config.backoff.maxIdleSeconds)
    : config.idleSeconds);
}

/**
 * @spec Only a successful timer-only execution with completed receipts and no business backlog advances backoff.
 * @why The caller commits this patch with execution release; its execution-ID fence makes repeated finalization harmless.
 * @spec Concurrent business arrivals change the root activity/version, so stale finalization cannot extend their wait.
 * @case tests/topic-trigger.test.ts
 * @link docs/personal/topic.md#topic-定时回顾
 */
export async function idleReviewCompletion(context: Pick<PluginContext, "resources" | "instance">,
  previous: Readonly<TopicResource>, current: Readonly<TopicResource>,
  outcome: { inputs?: readonly Input[]; succeeded: boolean; at: string }): Promise<Partial<TopicStatus>> {
  const config = ChiefTriggerConfigSchema.parse(context.instance.config.chiefTrigger ?? {});
  if (!config.backoff) return {};
  const { inputs, succeeded, at } = outcome;
  const enabled = !current.spec.parentRef && !current.metadata.deletionTimestamp && topicTrigger(current.spec.trigger).enabled;
  let quiet = enabled && succeeded && !!inputs?.length && inputs.every(i => i.spec.origin === "trigger")
    && !current.status.execution?.admissionRevision && current.status.lastInputAt === previous.status.lastInputAt
    && current.status.weaveRevision === previous.status.weaveRevision;
  if (quiet) {
    const receipts = await Promise.all(inputs!.map(i => context.resources.get<InputSpec, InputStatus>(resourceRef(i))));
    quiet = receipts.every((i, index) => i?.metadata.uid === inputs![index]!.metadata.uid
      && i?.status.assess?.executionId === current.status.execution!.id && !!i.status.assess.completedAt);
    if (quiet) {
      const topics = await readTopicSubtree(context.resources, resourceRef(current));
      quiet = !(await pendingInputs(context.resources, resourceRef(current), topics)).some(i => i.spec.origin !== "trigger");
    }
  }
  const idleReviewCount = quiet ? Math.min(Number.MAX_SAFE_INTEGER, (current.status.idleReviewCount ?? 0) + 1) : 0;
  return { idleReviewCount, nextTriggerAt: enabled ? new Date(Date.parse(at) + idleReviewDelay(config, idleReviewCount)).toISOString() : null };
}

/**
 * @spec An idle review is born routed to its root, with normal attention and no new authority.
 * @why Advancing the check and creating its Input atomically prevents duplicate reviews; the Topic version fences regrouping and concurrent execution.
 * @spec Timer Inputs do not refresh lastInputAt, so periodic reflection cannot keep a quiet Topic alive forever.
 * @case tests/topic-trigger.test.ts
 * @link docs/personal/topic.md#topic-定时回顾
 */
export async function createTriggerInput(context: Pick<PluginContext, "resources" | "logger">, topic: Readonly<TopicResource>, nextTriggerAt: string, agenda?: Awaited<ReturnType<typeof maintenanceAgenda>>) {
  if (topic.spec.parentRef || topic.metadata.deletionTimestamp || topic.status.execution || !topicTrigger(topic.spec.trigger).enabled)
    throw new Error("Idle review requires an enabled, idle root Topic");
  const dueAt = topic.status.nextTriggerAt!;
  const inputId = `topic-trigger-${digest([topic.metadata.uid, dueAt])}`;
  const at = new Date().toISOString();
  const idleSince = topic.status.idleSince ?? topic.metadata.creationTimestamp;
  const target = resourceRef(topic);
  const spec: InputSpec = {
    origin: "trigger", originId: "personal.topic-trigger", originRef: target, topicId: topic.spec.id, attention: InputAttention.Normal,
    text: `${agenda?.reason === "organize_material" ? "Review direct Input and Work ownership. Create meaningful children and move materials where useful; assess admitted Inputs before moving them." : agenda?.reason === "organize_children" ? "Review child organization. Regroup children or detach a coherent independent subtree when justified; a count alone does not justify splitting." : "Review current understanding, unresolved questions and relevant Work; update summaries only when useful."} Scheduled review at ${at}. Act within existing authorization; this is not a new user request and communication is optional. Record the review with assess_input, including when nothing needs action.${agenda ? `\nMaintenance facts: ${JSON.stringify(agenda)}` : ""}`,
    observation: { dueAt, triggeredAt: at, idleSince, ...(agenda ? { maintenance: agenda } : {}) },
  };
  const status: InputStatus = {
    topic: target,
    route: { completedAt: at, result: { topics: [target], reason: "Scheduled review of this root Topic" } },
    assess: {},
  };
  await commitStatus(context.resources, [
    { operation: "patchStatus", resource: topic, patch: { nextTriggerAt } },
    { operation: "create", type: INPUT_TYPE, name: inputId, spec, status },
  ]);
  context.logger.info("Chief idle review requested", { attributes: { topicUid: topic.metadata.uid, inputId, dueAt, idleSince, reason: agenda?.reason ?? "review" } });
  return (await context.resources.get<InputSpec, InputStatus>(inputRef(inputId)))!;
}
