import { z } from "zod";

/** Execution app/user pins CLI access. Me uses its own app-scoped identities and does not select credentials. */
export const LarkMessagesConfigSchema = z.object({
  appId: z.string().regex(/^cli_[a-zA-Z0-9]+$/).optional(),
  userId: z.string().regex(/^ou_[a-zA-Z0-9]+$/).optional(),
  me: z.array(z.object({ appId: z.string().regex(/^cli_[a-zA-Z0-9]+$/), openId: z.string().regex(/^ou_[a-zA-Z0-9]+$/) }).strict()).max(99).refine((items) => new Set(items.map((i) => `${i.appId}:${i.openId}`)).size === items.length, "Duplicate Me identity").default([]),
  timeoutMs: z.number().int().min(1000).max(25_000).default(20_000),
}).strict().refine((c) => Boolean(c.appId) === Boolean(c.userId), "CLI appId and userId must be configured together");
export type LarkMessagesConfig = { appId: string; userId: string; timeoutMs: number };
