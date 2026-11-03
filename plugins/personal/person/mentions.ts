import type { Persons } from "./service.ts";

export interface LarkMention { key: string; id: string; name?: string; type?: string }

/** @spec Only platform-typed human mentions create Persons; bot, all and unresolved mentions never infer a human.
 * @spec Mention discovery grants no Address membership or delivery permission.
 * @spec App-scoped IDs establish identity; names only label it and never merge identities across apps.
 * @case tests/lark.test.ts
 * @link docs/personal/input.md#人物与场合
 */
export async function observeMentionedPeople(persons: Persons, accountId: string, ids: readonly string[],
  mentions: readonly LarkMention[], assistantId?: string): Promise<void> {
  const excluded = new Set(["all", ...(assistantId ? [assistantId] : []),
    ...mentions.filter(m => m.type === "bot" || m.key === "@_all").map(m => m.id)]);
  for (const mention of mentions) {
    if (mention.type !== "user" || excluded.has(mention.id) || !ids.includes(mention.id)) continue;
    await persons.observe({ provider: "lark", scope: accountId, id: mention.id }, mention.name);
  }
}

