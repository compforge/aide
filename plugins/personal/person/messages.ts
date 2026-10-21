import type { ChatMessage, MessageConnector } from "@compforge/aide-plugin";
import type { Persons } from "./service.ts";
import { personRef } from "./model.ts";

export async function observePeople(persons: Persons, scope: string, messages: readonly ChatMessage[]) {
  const senders = new Map<string, ReturnType<typeof personRef>>();
  for (const message of messages) {
    if (message.sender.type === "user" && message.sender.id) senders.set(message.id, personRef(await persons.observe({ provider: "lark", scope, id: message.sender.id }, message.sender.name)));
    // Bare mention IDs can identify bots. Keep them as evidence until a user sender establishes a Person.
  }
  return senders;
}
/** Reading connector messages also contributes external identity facts; it never synthesizes a profile. */
export function personMessages(messages: MessageConnector, persons: Persons, scope: string): MessageConnector {
  const observe = async (page: Awaited<ReturnType<MessageConnector["search"]>>) => { await observePeople(persons, scope, page.messages); return page; };
  return { identity: () => messages.identity(), search: async (query) => observe(await messages.search(query)),
    history: async (query) => observe(await messages.history(query)), thread: async (query) => observe(await messages.thread(query)) };
}
