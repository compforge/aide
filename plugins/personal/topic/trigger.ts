import { commitStatus } from "../status.ts";
import type { maintenanceAgenda } from "./maintenance.ts";
import { z } from "zod";
import type { PluginContext } from "@compforge/aide-plugin";
import type { TopicResource } from "./model.ts";
import { INPUT_TYPE, InputAttention, type InputSpec, type InputStatus } from "../input/model.ts";
import { inputRef, resourceRef } from "../input/state.ts";
import { digest } from "../chief-model.ts";

/** Root Topics opt into Chief idle reviews; cadence belongs to Chief configuration. */
export const TopicTriggerSchema = z.object({ enabled: z.boolean().default(true) }).strict();
export type TopicTrigger = z.infer<typeof TopicTriggerSchema>;
export const topicTrigger = (trigger?: TopicTrigger): TopicTrigger => TopicTriggerSchema.parse(trigger ?? {});

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
