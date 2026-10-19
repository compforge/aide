import { z } from "zod";
export const IncomingSchema = z.object({
  id: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
  text: z.string().min(1).max(32_000),
});
export type Incoming = z.infer<typeof IncomingSchema>;

export const MessageSchema = z.object({
  id: z.string(), conversationId: z.string(), at: z.string(),
  role: z.enum(["user", "aide"]), text: z.string(), workId: z.string().nullable(),
});
export type Message = z.infer<typeof MessageSchema>;

