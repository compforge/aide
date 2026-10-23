import { z } from "zod";
import { CronExpressionParser } from "cron-parser";

export const TriggerSchema = z.object({
  cron: z.string().nullable(),
  timezone: z.string(),
  event: z.string().nullable(),
});
export type Trigger = z.infer<typeof TriggerSchema>;

export const WorkInputRequestSchema = z.object({
  note: z.string().min(1).max(16000).optional(),
  action: z.enum(["context", "update", "pause", "resume", "answer"]).default("context"),
  changes: z.object({ title: z.string().min(1).optional(), instruction: z.string().min(1).optional(), trigger: TriggerSchema.nullable().optional() }).strict().optional(),
}).strict().refine(v => v.action === "update" ? !!v.changes && Object.keys(v.changes).length > 0 : !v.changes,
  "Only an update request accepts and requires changes");
export type WorkInputRequest = z.infer<typeof WorkInputRequestSchema>;

export const WorkSchema = z.object({
  uid: z.string().optional(),
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
  history: z.array(z.object({ at: z.string(), role: z.enum(["user", "aide", "event"]), text: z.string() })),
});
export type Work = z.infer<typeof WorkSchema>;

export type WorkSpecFields = Pick<Work, "conversationId" | "title" | "instruction" | "revision">;
export interface Delivery {
  inputs: Array<{ key: string; responseId: string }>;
  events: string[];
}
export type WorkStatus = Omit<Work, keyof WorkSpecFields | "id" | "uid" | "kind" | "trigger"> & Delivery;

export { IncomingSchema, type Incoming } from "../../src/channel/message.ts";
export type { OutputDraft, OutputView } from "../../src/output.ts";

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

export const WorkSpecSchema = WorkSchema.pick({ conversationId: true, title: true, instruction: true, revision: true }).strict();
export const WorkStatusSchema = WorkSchema.pick({ status: true, nextAt: true, question: true, history: true }).extend({
  inputs: z.array(z.object({ key: z.string(), responseId: z.string() }).strict()), events: z.array(z.string()),
}).strict();
