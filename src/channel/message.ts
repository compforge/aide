import { ChannelAddressSchema } from "./address.ts";
import { z } from "zod";
export const IncomingSchema = z.object({
  source: ChannelAddressSchema,
  id: z.string().min(1).max(200),
  channelId: z.string().min(1),
  topicKey: z.string().min(1).max(500).optional(),
  topicId: z.string().min(1).optional(),
  text: z.string().min(1).max(32_000),
  observation: z.record(z.string(), z.unknown()).optional(),
});
export type Incoming = z.infer<typeof IncomingSchema>;
