import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import type { Message } from "../../src/channel/message.ts";

export const TriggerSchema = z.object({
  cron: z.string().nullable(),
  timezone: z.string(),
  event: z.string().nullable(),
});
export type Trigger = z.infer<typeof TriggerSchema>;

export const WorkInputSchema = z.object({
  id: z.string(), at: z.string(), inputId: z.string().optional(),
  origin: z.enum(["channel", "source", "chief"]),
  text: z.string(), note: z.string().optional(),
  observation: z.record(z.string(), z.unknown()).optional(),
  action: z.enum(["context", "update", "pause", "resume", "answer"]),
  changes: z.object({ title: z.string().min(1).optional(), instruction: z.string().min(1).optional(), trigger: TriggerSchema.nullable().optional() }).strict().optional(),
});
export type WorkInput = z.infer<typeof WorkInputSchema>;

export const WorkSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  kind: z.enum(["task", "routine"]),
  title: z.string(),
  instruction: z.string(),
  trigger: TriggerSchema.nullable(),
  status: z.enum(["ready", "running", "waiting", "scheduled", "paused", "done", "uncertain", "invalid_result"]),
  revision: z.number().int(),
  nextAt: z.string().nullable(),
  question: z.string().nullable(),
  inputs: z.array(WorkInputSchema).default([]),
  consumedInputIds: z.array(z.string()).default([]),
  history: z.array(z.object({ at: z.string(), role: z.enum(["user", "aide", "event"]), text: z.string() })),
});
export type Work = z.infer<typeof WorkSchema>;

export type WorkSpecFields = Pick<Work, "conversationId" | "title" | "instruction" | "revision" | "inputs">;
export interface Delivery {
  messages: Message[];
  inputs: Array<{ key: string; responseId: string }>;
  events: string[];
}
export type WorkStatus = Omit<Work, keyof WorkSpecFields | "id" | "kind" | "trigger"> & Delivery & { laneId?: string };

export { IncomingSchema, MessageSchema, type Incoming, type Message } from "../../src/channel/message.ts";

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
