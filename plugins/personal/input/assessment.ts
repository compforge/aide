import { z } from "zod";
import { AgentStatusSchema } from "../execution/session.ts";
import { AgentCallSchema } from "../observation/reference.ts";

/** Shared execution and business receipt contract for an Input or a whole Batch. */
export const AttemptSchema = z.object({ agent: AgentStatusSchema.optional(), completedBy: AgentCallSchema.optional(),
  executionId: z.string().optional(), deliveryId: z.string().optional(), startedAt: z.string().optional(), completedAt: z.string().optional(),
  lastError: z.string().optional(), errorAt: z.iso.datetime().optional(), retryable: z.boolean().optional() }).strict();
export const CuratedNotesSchema = z.array(z.object({ noteId: z.string().min(1), version: z.string().min(1) }).strict()).max(32);
export const NoteAssessmentSchema = z.object({ noteId: z.string(), status: z.enum(["confirmed", "already_curated", "unavailable", "version_changed", "needs_nature", "deferred"]) }).strict();
export type NoteAssessment = z.infer<typeof NoteAssessmentSchema>;
export const AssessmentSchema = AttemptSchema.extend({ curationRetried: z.boolean().optional(), result: z.object({ summary: z.string(), curatedNotes: CuratedNotesSchema.optional(), noteResults: z.array(NoteAssessmentSchema).max(64).optional(),
  disposition: z.enum(["completed", "cancelled", "rejected"]).optional() }).strict().optional() });
