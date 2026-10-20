import { z } from "zod";

/** Pin the user and app because open_id is app-scoped and CLI login can change independently. */
export const LarkMessagesConfigSchema = z.object({
  appId: z.string().regex(/^cli_[a-zA-Z0-9]+$/),
  userId: z.string().regex(/^ou_[a-zA-Z0-9]+$/),
  timeoutMs: z.number().int().min(1000).max(25_000).default(20_000),
}).strict();
export type LarkMessagesConfig = z.infer<typeof LarkMessagesConfigSchema>;
