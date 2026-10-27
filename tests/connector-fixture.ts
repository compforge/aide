import type { EnvironmentDirectory } from "@compforge/aide-connector/environment";
import type { ForgeReader } from "@compforge/repocli";
import type { RequirementConnector, RequirementOperations } from "@compforge/aide-connector/requirement";
import { Connectors } from "../connectors/index.ts";
import { ConnectorRegistry } from "../src/host/connector/registry.ts";
import { forgeImplementation } from "@compforge/aide-connector/forge";

/** Inject readers while exercising the same registry/client/IPC path as installed factories. */
export function createConnectors(requirements: readonly RequirementConnector[], forges: readonly ForgeReader[], environments?: EnvironmentDirectory): Connectors {
  const registry = new ConnectorRegistry();
  for (const reader of forges) registry.register("forge", "v1", reader.forge, forgeImplementation(reader));
  for (const provider of requirements) registry.register<RequirementOperations>("requirement", "v1", provider.source, {
    handlers: {
      list: (_call, query) => provider.list(query), get: (_call, key) => provider.get(key),
      identity: () => provider.identity(), comments: (_call, key, query) => provider.comments(key, query),
    }, metadata: { provider: provider.provider },
    hostHandlers: provider.addComment ? { addComment: (_call, key, comment) => provider.addComment!(key, comment) } : undefined,
  });
  if (environments) registry.register<EnvironmentDirectory>("environment", "v1", "environments", { handlers: {
    list: () => environments.list(), get: (_call, name) => environments.get(name), workloads: (_call, name, namespace) => environments.workloads(name, namespace),
  } });
  return new Connectors(registry);
}
