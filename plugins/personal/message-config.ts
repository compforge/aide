import { z } from "zod";

export const MESSAGE_SESSION = "source:lark-messages";
/** Observation policy belongs to Personal; the Connector only exposes account-scoped IM reads. */
export const MessageWatchSchema = z.object({
  kinds: z.array(z.enum(["direct", "mention"])).default(["direct", "mention"]),
  intervalMs: z.number().int().min(30_000).max(3_600_000).default(60_000),
  overlapMs: z.number().int().min(60_000).max(3_600_000).default(300_000),
  initialLookbackMs: z.number().int().min(60_000).max(86_400_000).default(300_000),
  contextWindowMs: z.number().int().min(60_000).max(3_600_000).default(900_000),
  beforeMessages: z.number().int().min(1).max(49).default(20),
  afterMessages: z.number().int().min(1).max(49).default(10),
  maxContextChars: z.number().int().min(1000).max(100_000).default(16_000),
  followupMs: z.number().int().min(0).max(3_600_000).default(300_000),
  contextAttempts: z.number().int().min(1).max(5).default(2),
}).strict().refine((watch) => new Set(watch.kinds).size === watch.kinds.length, "Duplicate message kind");
export type MessageKind = "direct" | "mention";
export type MessageWatch = z.infer<typeof MessageWatchSchema> & { accountId: string; userId: string };

export function messageWatch(config: Readonly<Record<string, unknown>> = {}, account?: { appId: string; userId: string }): MessageWatch | undefined {
  if (config.messages === undefined) return undefined;
  const watch = MessageWatchSchema.parse(config.messages);
  if (!watch.kinds.length) return undefined;
  if (!account) throw new Error("Personal messages require connectors.lark with explicit appId/userId");
  return { ...watch, accountId: account.appId, userId: account.userId };
}
