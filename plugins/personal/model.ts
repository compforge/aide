import { z } from "zod";
import { CronExpressionParser } from "cron-parser";

export const TriggerSchema = z.object({
  cron: z.string().nullable(),
  timezone: z.string(),
  event: z.string().nullable(),
});
export type Trigger = z.infer<typeof TriggerSchema>;

export const WorkSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  kind: z.enum(["task", "routine"]),
  title: z.string(),
  instruction: z.string(),
  trigger: TriggerSchema.nullable(),
  status: z.enum(["ready", "running", "waiting", "scheduled", "paused", "done", "uncertain"]),
  revision: z.number().int(),
  nextAt: z.string().nullable(),
  question: z.string().nullable(),
  history: z.array(z.object({ at: z.string(), role: z.enum(["user", "aide", "event"]), text: z.string() })),
});
export type Work = z.infer<typeof WorkSchema>;

export const IncomingSchema = z.object({
  id: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
  text: z.string().min(1).max(32_000),
});
export type Incoming = z.infer<typeof IncomingSchema>;

export const MessageSchema = z.object({
  id: z.string(), conversationId: z.string(), at: z.string(),
  role: z.enum(["user", "aide"]), text: z.string(), workId: z.string().nullable(),
});
export type Message = z.infer<typeof MessageSchema>;

/** @spec Task completion ends a goal; Routine completion only ends its current occurrence. */
export function nextOccurrence(trigger: Trigger | null, now: Date): string | null {
  if (!trigger?.cron) return null;
  return CronExpressionParser.parse(trigger.cron, { currentDate: now, tz: trigger.timezone }).next().toISOString();
}

export function validateTrigger(kind: Work["kind"], trigger: Trigger | null, now: Date): void {
  if (kind === "task" && trigger !== null) throw new Error("Task cannot have a recurring trigger");
  if (kind === "routine" && (!trigger || (!trigger.cron && !trigger.event))) {
    throw new Error("Routine needs a cron expression or event name");
  }
  if (trigger) {
    new Intl.DateTimeFormat("en", { timeZone: trigger.timezone });
    nextOccurrence(trigger, now);
  }
}
