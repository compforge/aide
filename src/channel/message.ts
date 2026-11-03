import type { TopicLocator } from "../../plugins/personal/topic/locator.ts";
import { ChannelAddressSchema } from "./address.ts";
import { z } from "zod";
export const IncomingSchema = z.object({
  inputKey: z.string().min(1).max(2000).optional(),
  source: ChannelAddressSchema,
  id: z.string().min(1).max(200),
  channelId: z.string().min(1),
  topicKey: z.string().min(1).max(500).optional(),
  topicId: z.string().min(1).optional(),
  topicName: z.string().trim().min(1).max(80).optional(),
  text: z.string().min(1).max(32_000),
  replyToMessageId: z.string().min(1).optional(),
  addressObservation: z.object({ name: z.string().optional(), type: z.enum(["direct", "group", "web", "external"]).optional() }).optional(),
  observation: z.record(z.string(), z.unknown()).optional(),
});
export type Incoming = z.infer<typeof IncomingSchema>;

/** Web messages explicitly select a Topic rather than deriving a source key. */
export const webTopicLocator = {
  locate: ({ topicId }) => ({ selector: { kind: "id" as const, id: topicId } }),
} satisfies TopicLocator<{ topicId: string }>;
