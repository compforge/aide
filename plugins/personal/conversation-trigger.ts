import { z } from "zod";

/** A trigger schedules a Reconcile; its business decisions belong to the controller. */
export const ConversationTriggerSchema = z.object({
  enabled: z.boolean().default(false),
  intervalSeconds: z.number().int().positive().max(2_147_483).default(3600),
}).strict();
export type ConversationTrigger = z.infer<typeof ConversationTriggerSchema>;
export const conversationTrigger = (trigger?: ConversationTrigger): ConversationTrigger => ConversationTriggerSchema.parse(trigger ?? {});
export const nextTriggerAt = (trigger: ConversationTrigger, now = Date.now()): string => new Date(now + trigger.intervalSeconds * 1000).toISOString();
