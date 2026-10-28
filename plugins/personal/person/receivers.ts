import type { ChatMessage } from "@compforge/aide-plugin";
import { personRef, type PersonRef } from "./model.ts";
import type { Persons } from "./service.ts";

/** @spec Bare mentions are not human identities. Resolve only already known Persons in this account.
 * @spec An empty result is no identified recipient, never an all-audience marker or member expansion.
 * @case tests/topic-persons.test.ts
 * @link docs/personal/input.md#接收人物
 */
export async function knownReceivers(persons: Persons, accountId: string, ids: readonly string[]): Promise<PersonRef[]> {
  const refs = new Map<string, PersonRef>();
  for (const id of new Set(ids)) {
    const person = await persons.findIdentity({ provider: "lark", scope: accountId, id });
    if (person) { const ref = personRef(person) as PersonRef; refs.set(ref.uid, ref); }
  }
  return [...refs.values()];
}

/** Direct inbound delivery and a known human reply author establish addressed people, independently of Me marks. */
export async function messageReceivers(persons: Persons, accountId: string, message: ChatMessage,
  context: readonly ChatMessage[], directAccountId?: string): Promise<PersonRef[]> {
  const refs = new Map((await knownReceivers(persons, accountId, message.mentions)).map(ref => [ref.uid, ref]));
  const parent = context.find(m => !m.deleted && m.chatId === message.chatId && m.id === message.parentId);
  const identities = [
    ...(parent?.sender.type === "user" ? [{ id: parent.sender.id, name: parent.sender.name }] : []),
    ...(directAccountId && message.sender.type === "user" && message.sender.id !== directAccountId ? [{ id: directAccountId }] : []),
  ];
  for (const { id, name } of identities) {
    const person = await persons.observe({ provider: "lark", scope: accountId, id }, name);
    const ref = personRef(person) as PersonRef; refs.set(ref.uid, ref);
  }
  return [...refs.values()];
}
