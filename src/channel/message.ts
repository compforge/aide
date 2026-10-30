import { SensitivitySchema, VisibilitySchema, DisclosureFields } from "../../plugins/personal/disclosure.ts";
import type { TopicLocator } from "../../plugins/personal/topic/locator.ts";
import { ChannelAddressSchema } from "./address.ts";
import { z } from "zod";
export const IncomingSchema = z.object({
  source: ChannelAddressSchema,
  id: z.string().min(1).max(200),
  channelId: z.string().min(1),
  topicKey: z.string().min(1).max(500).optional(),
  topicId: z.string().min(1).optional(),
  topicName: z.string().trim().min(1).max(80).optional(),
  sensitivity: SensitivitySchema.optional(), visibility: VisibilitySchema.optional(), disclosureScope: DisclosureFields.disclosureScope,
  text: z.string().min(1).max(32_000),
  observation: z.record(z.string(), z.unknown()).optional(),
});
export type Incoming = z.infer<typeof IncomingSchema>;

/** Web messages explicitly select a Topic rather than deriving a source key. */
export const webTopicLocator = {
  locate: ({ topicId }) => ({ selector: { kind: "id" as const, id: topicId } }),
} satisfies TopicLocator<{ topicId: string }>;
