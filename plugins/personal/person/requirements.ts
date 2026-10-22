import type { ConnectorClient, RequirementAccount, RequirementUser } from "@compforge/aide-plugin";
import type { Persons } from "./service.ts";
import { personRef } from "./model.ts";

export async function observeRequirementPeople(persons: Persons, account: RequirementAccount, users: readonly RequirementUser[]) {
  const result = new Map<string, ReturnType<typeof personRef>>();
  for (const user of users) result.set(user.key, personRef(await persons.observe({ provider: account.provider, scope: account.scope, id: user.key }, user.name)));
  return result;
}
/** @spec Reads contribute identities only; profile synthesis remains Chief's responsibility. */
export function personRequirements(requirements: ConnectorClient["requirements"], persons: Persons): ConnectorClient["requirements"] {
  return { identity: (source) => requirements.identity(source),
    async list(source, query) {
      const page = await requirements.list(source, query);
      if (page.items.some((item) => item.assignees?.length)) await observeRequirementPeople(persons, await requirements.identity(source), page.items.flatMap((item) => item.assignees ?? []));
      return page;
    },
    async get(identity) {
      const item = await requirements.get(identity);
      if (item.assignees?.length) await observeRequirementPeople(persons, await requirements.identity(identity.source), item.assignees);
      return item;
    },
    async comments(identity, query) {
      const page = await requirements.comments(identity, query);
      if (page.items.length) await observeRequirementPeople(persons, await requirements.identity(identity.source), page.items.flatMap((item) => [...(item.author ? [item.author] : []), ...item.mentions ?? []]));
      return page;
    },
  };
}
