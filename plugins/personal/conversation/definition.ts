import { z } from "zod";
import { ConversationTriggerSchema } from "./trigger.ts";
import type { ResourceDefinition, ResourceValidationContext } from "@compforge/aide-plugin";
import { AddressSchema } from "../../../src/address.ts";
import { CONVERSATION_TYPE, type ConversationStatus, type ConversationSpec, type ConversationResource } from "./model.ts";
import { LoopExecutionSchema } from "../loop.ts";
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
    status: z.object({  receipts: z.array(z.object({ key: z.string(), responseId: z.string() }).strict()).default([]),
      nextTriggerAt: z.string().nullable().optional(), execution: LoopExecutionSchema.nullable().optional(), summary: z.string().max(16000).optional() }).strict() },
  validator: { create: validateDefault, update: (_previous, current, context) => validateDefault(current, context) },
  retention: { releasedAt: () => undefined, references: () => {
    return [];
  } },
};
