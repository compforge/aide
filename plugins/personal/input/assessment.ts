import { z } from "zod";
import { AgentStatusSchema } from "../execution/session.ts";
import { AgentCallSchema } from "../observation/reference.ts";

/** Shared execution and business receipt contract for an Input or a whole Batch. */
export const AttemptSchema = z.object({ agent: AgentStatusSchema.optional(), completedBy: AgentCallSchema.optional(),
  executionId: z.string().optional(), deliveryId: z.string().optional(), startedAt: z.string().optional(), completedAt: z.string().optional(),
  lastError: z.string().optional(), errorAt: z.iso.datetime().optional(), retryable: z.boolean().optional() }).strict();
export const CuratedNotesSchema = z.array(z.object({ noteId: z.string().min(1), version: z.string().min(1) }).strict()).max(32);
export const AssessmentSchema = AttemptSchema.extend({ result: z.object({ summary: z.string(), curatedNotes: CuratedNotesSchema.optional(),
  disposition: z.enum(["completed", "cancelled", "rejected"]).optional() }).strict().optional() });
