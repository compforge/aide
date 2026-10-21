import { z } from "zod";
import type { InputRelation } from "@compforge/aide-plugin";

/** An external identity is meaningful only within its provider's ID namespace. */
export interface PersonIdentity {
  readonly provider: string;
  readonly scope: string;
  readonly id: string;
}

/**
 * @spec Personal serves one Person across Channels, Sources and Conversations.
 * Explicit identity bindings identify the human; connector credentials and bot IDs do not.
 * @why Account attribution must not change when Chief revises its understanding in PERSON.md.
 * @link docs/plugin/personal.md
 */
export interface Person {
  readonly identities: readonly PersonIdentity[];
}

const IdentitySchema = z.object({
  provider: z.string().trim().min(1), scope: z.string().trim().min(1), id: z.string().trim().min(1),
}).strict().superRefine((identity, context) => {
  if (identity.provider !== "lark") return;
  if (!/^cli_[a-zA-Z0-9]+$/.test(identity.scope)) context.addIssue({ code: "custom", path: ["scope"], message: "Lark identity scope must be an appId" });
  if (!/^ou_[a-zA-Z0-9]+$/.test(identity.id)) context.addIssue({ code: "custom", path: ["id"], message: "Lark identity must use open_id" });
});

export const PersonSchema = z.object({ identities: z.array(IdentitySchema).default([]) }).strict()
  .superRefine((person, context) => {
    const keys = person.identities.map(({ provider, scope, id }) => JSON.stringify([provider, scope, id]));
    if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", path: ["identities"], message: "Duplicate Person identity" });
  });

export function isPerson(person: Person, identity: PersonIdentity): boolean {
  return person.identities.some((candidate) => candidate.provider === identity.provider
    && candidate.scope === identity.scope && candidate.id === identity.id);
}

/** @spec Missing identity evidence is unknown, never a fallback to observed. Sent takes precedence over received. */
export function relationToPerson(person: Person, evidence: {
  author?: PersonIdentity; recipients?: readonly PersonIdentity[]; observer?: PersonIdentity;
}): InputRelation | undefined {
  if (evidence.author && isPerson(person, evidence.author)) return "sent";
  if (evidence.recipients?.some((identity) => isPerson(person, identity))) return "received";
  if (evidence.observer && isPerson(person, evidence.observer)) return "observed";
  return undefined;
}

const LarkObservation = z.object({ provider: z.literal("lark"), accountId: z.string(),
  sender: z.object({ id: z.string().optional(), type: z.string() }), mentions: z.array(z.string()) });

/** Channel adapters retain evidence; Personal owns its interpretation relative to the served human. */
export function channelRelation(person: Person, input: { channelId: string; observation?: Record<string, unknown> }): InputRelation | undefined {
  if (input.channelId === "web") return "sent"; // The local single-person UI is the Person's own entry point.
  if (input.channelId !== "lark") return undefined;
  const result = LarkObservation.safeParse(input.observation);
  if (!result.success) return undefined;
  const { accountId: scope, sender, mentions } = result.data;
  return relationToPerson(person, {
    ...(sender.type === "user" && sender.id ? { author: { provider: "lark", scope, id: sender.id } } : {}),
    recipients: mentions.map((id) => ({ provider: "lark", scope, id })),
  });
}
