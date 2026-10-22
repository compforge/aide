import { z } from "zod";
import { ConversationTriggerSchema } from "./trigger.ts";
import type { ResourceDefinition, ResourceValidationContext } from "@compforge/aide-plugin";
import { AddressSchema } from "../../../src/address.ts";
import { CONVERSATION_TYPE, type ConversationStatus, type ConversationSpec, type ConversationResource } from "./model.ts";
const BatchSchema = z.object({ id: z.string(), inputIds: z.array(z.string()),
  context: z.object({ prompt: z.string(), history: z.string(), responseRequired: z.boolean() }).strict(),
  createdAt: z.string(), timerAt: z.string().optional(), phase: z.enum(["queued", "running", "compacting", "done", "failed", "interrupted"]),
  executionId: z.string().optional(), deadline: z.string().optional(), cancelRequested: z.boolean().optional(),
  failureStage: z.enum(["execution", "compaction"]).optional(), communicated: z.boolean().optional(), quietReason: z.string().optional(),
  outputIds: z.array(z.string()), result: z.object({ summary: z.string(), outputs: z.array(z.string()).optional(), context: z.string().optional(), error: z.string().optional() }).strict().optional(),
  compaction: z.object({ offset: z.number().int().nonnegative(), text: z.string() }).strict().optional(),
}).strict();
/** @spec User selection and Route fallback cannot establish two live Default conversations. */
function validateDefault(resource: Readonly<ConversationResource>, context: ResourceValidationContext) {
  if (resource.spec.default && !resource.metadata.deletionTimestamp && context.list<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE)
    .some(c => c.spec.default && !c.metadata.deletionTimestamp && c.metadata.uid !== resource.metadata.uid)) {
    throw new Error("Default Conversation already exists");
  }
}
export const ConversationDefinition: ResourceDefinition<ConversationSpec, ConversationStatus> = {
  type: CONVERSATION_TYPE,
  schema: { spec: z.object({ id: z.string(), address: AddressSchema.optional(), name: z.string().optional(), default: z.boolean().optional(),
    trigger: ConversationTriggerSchema.optional() }).strict(),
    status: z.object({ pendingInputIds: z.array(z.string()).default([]), receipts: z.array(z.object({ key: z.string(), responseId: z.string() }).strict()).default([]),
      nextTriggerAt: z.string().nullable().optional(), batch: BatchSchema.nullable().optional() }).strict() },
  validator: { create: validateDefault, update: (_previous, current, context) => validateDefault(current, context) },
  retention: { releasedAt: () => undefined, references: (r) => {
    const s = r.status as ConversationStatus;
    return [...new Set([...s.pendingInputIds, ...s.batch?.inputIds ?? []])].map((id) => `input:${id}`)
      .concat((s.batch?.outputIds ?? []).map((id) => `output:${id}`));
  } },
};
