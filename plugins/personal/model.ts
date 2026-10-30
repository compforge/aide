import { NoteViewSchema, NoteReferenceSchema } from "./note/model.ts";
import { ConditionsSchema, type Condition } from "./conditions.ts";
import { OrganizationSchema } from "./topic/ref.ts";
import { ContextFields } from "./context.ts";
import { ResourceRefSchema } from "./topic/ref.ts";
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

export const WorkSchema = z.object({ recent: z.array(NoteViewSchema).default([]),
  conditions: ConditionsSchema,
  uid: z.string().optional(),
  id: z.string(),
  topicId: z.string(),
  kind: z.enum(["task", "routine"]),
  title: z.string(),
  instruction: z.string(),
  trigger: TriggerSchema.nullable(),
  status: z.enum(["ready", "running", "waiting", "scheduled", "paused", "done", "uncertain", "invalid_result"]),
  revision: z.number().int(),
  nextAt: z.string().nullable(),
  question: z.string().nullable(),
  lastReport: z.object({ at: z.string(), text: z.string().max(16000) }).strict().optional(),
  recoveryNotice: z.object({ id: z.string(), text: z.string() }).strict().nullable().optional(),
  ...ContextFields, summary: z.string().default(""), summaryUid: z.string().default(""), summaryNote: NoteReferenceSchema.optional(),
});
export type Work = z.infer<typeof WorkSchema>;

export type WorkSpecFields = Pick<Work, "title" | "instruction"> & { paused?: boolean };
export interface WorkStatus {
  topic: import("@compforge/aide-plugin").ResourceRef & { uid: string };
  organization?: z.infer<typeof OrganizationSchema>;
  summaryRevision?: string; contextWriter?: import("./note/model.ts").NoteStatus["writer"];
  conditions?: Condition[];
  waiting?: { question?: string; until?: string } | null;
  recovery?: { reason: "ExecutionUncertain" | "InvalidResult"; message: string } | null;
  lastReport?: { at: string; text: string };
  recoveryNotice?: { id: string; text: string } | null;
  completion?: WorkOutcome | null;
  lastOccurrence?: WorkOutcome | null;
  nextTriggerAt?: string | null;
}
export interface WorkOutcome { at: string; text: string; observedGeneration: number; executionId?: string }


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

export const WorkSpecSchema = WorkSchema.pick({ title: true, instruction: true }).extend({ paused: z.boolean().default(false) }).strict();
export const WorkOutcomeSchema = z.object({ at: z.string().datetime(), text: z.string(), observedGeneration: z.number().int().positive(), executionId: z.string().optional() }).strict();
export const WorkStatusSchema = z.object({ ...ContextFields, topic: ResourceRefSchema, organization: OrganizationSchema.optional(), conditions: ConditionsSchema,
  waiting: z.object({ question: z.string().min(1).optional(), until: z.string().datetime().optional() }).strict().nullable().optional(),
  recovery: z.object({ reason: z.enum(["ExecutionUncertain", "InvalidResult"]), message: z.string() }).strict().nullable().optional(),
  lastReport: WorkSchema.shape.lastReport, recoveryNotice: WorkSchema.shape.recoveryNotice,
}).strict();
