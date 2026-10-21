import type { ChatMessage, InputRelation } from "@compforge/aide-plugin";
import { relationToPerson } from "../../person/relation.ts";
import type { MessageWatch } from "./config.ts";

/**
 * @spec Execution login is verified separately; it never determines which identities are Me.
 * Classify individual messages, including retrieved context, before describing a discussion batch.
 * @case tests/message-source.test.ts
 */
export function messageRelation(watch: Pick<MessageWatch, "accountId" | "userId" | "personIds">, message: ChatMessage,
  direct: boolean, context: readonly ChatMessage[] = []): InputRelation | undefined {
  const identity = (id: string) => ({ provider: "lark", scope: watch.accountId, id });
  const person = { identities: watch.personIds.map(identity) };
  const parent = context.find((candidate) => candidate.id === message.parentId);
  const received = (direct && watch.personIds.includes(watch.userId)) || (parent?.sender.type === "user" && watch.personIds.includes(parent.sender.id));
  return relationToPerson(person, {
    ...(message.sender.type === "user" ? { author: identity(message.sender.id) } : {}),
    recipients: [...message.mentions.map(identity), ...(received ? person.identities : [])],
    observer: identity(watch.userId),
  });
}
