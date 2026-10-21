import { z } from "zod";
import { isPerson, type Person } from "../../person.ts";

export const MESSAGE_SESSION = "source:lark-messages";
/** Observation policy belongs to Personal; the Connector only exposes account-scoped IM reads. */
export const MessageWatchSchema = z.object({
  intervalMs: z.number().int().min(30_000).max(3_600_000).default(60_000),
  overlapMs: z.number().int().min(60_000).max(3_600_000).default(300_000),
  initialLookbackMs: z.number().int().min(60_000).max(86_400_000).default(300_000),
  contextWindowMs: z.number().int().min(60_000).max(3_600_000).default(900_000),
  beforeMessages: z.number().int().min(1).max(49).default(20),
  afterMessages: z.number().int().min(1).max(49).default(10),
  maxContextChars: z.number().int().min(1000).max(100_000).default(16_000),
  followupMs: z.number().int().min(0).max(3_600_000).default(300_000),
}).strict();
export type MessageKind = "direct" | "mention";
export type MessageWatch = z.infer<typeof MessageWatchSchema> & { accountId: string; userId: string; personIds: string[] };

export function messageWatch(watch: z.infer<typeof MessageWatchSchema> | undefined, account?: { appId: string; userId: string }, person: Person = { identities: [] }): MessageWatch | undefined {
  if (!watch) return undefined;
  if (!account) throw new Error("Personal messages require connectors.lark with explicit appId/userId");
  if (!isPerson(person, { provider: "lark", scope: account.appId, id: account.userId })) {
    throw new Error("Personal messages require a matching Lark identity in plugins.personal.person.identities; connector login alone does not identify the Person");
  }
  return { ...watch, accountId: account.appId, userId: account.userId,
    personIds: person.identities.filter((identity) => identity.provider === "lark" && identity.scope === account.appId).map((identity) => identity.id) };
}
