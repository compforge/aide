import { z } from "zod";

/** A trigger schedules a Reconcile; its business decisions belong to the controller. */
export const TopicTriggerSchema = z.object({
  enabled: z.boolean().default(false),
  intervalSeconds: z.number().int().positive().max(2_147_483).default(3600),
}).strict();
export type TopicTrigger = z.infer<typeof TopicTriggerSchema>;
export const topicTrigger = (trigger?: TopicTrigger): TopicTrigger => TopicTriggerSchema.parse(trigger ?? {});
export const nextTriggerAt = (trigger: TopicTrigger, now = Date.now()): string => new Date(now + trigger.intervalSeconds * 1000).toISOString();
