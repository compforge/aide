import { z } from "zod";
import type { InputRelation } from "@compforge/aide-plugin";
import type { Me, PersonIdentity } from "./model.ts";

export function isPerson(person: Me, identity: PersonIdentity): boolean {
  return person.identities.some((candidate) => candidate.provider === identity.provider
    && candidate.scope === identity.scope && candidate.id === identity.id);
}

/** @spec Missing identity evidence is unknown, never a fallback to observed. Sent takes precedence over received. */
export function relationToPerson(person: Me, evidence: {
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
export function channelRelation(person: Me, input: { channelId: string; observation?: Record<string, unknown> }): InputRelation | undefined {
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
