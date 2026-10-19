import type { ConnectorClient, EnvironmentDirectory, ForgeConnector, RequirementConnector } from "@compforge/aide-plugin";
import { createForgeConnectors } from "./forge/config.ts";
import { createMeegoRequirementConnectors } from "./requirements/meego.ts";
import { Environments } from "./environments.ts";

/** One host-owned set of provider clients; plugins receive only read capabilities. */
export class Connectors implements ConnectorClient {
  readonly requirements: ConnectorClient["requirements"];
  readonly forges: ConnectorClient["forges"];
  constructor(
    private readonly requirementProviders: readonly RequirementConnector[],
    private readonly forgeProviders: readonly ForgeConnector[],
    readonly environments: EnvironmentDirectory = new Environments(),
  ) {
    this.requirements = Object.freeze({
      list: (source, query) => this.requirement(source).list(query),
      get: (identity) => this.requirement(identity.source).get(identity),
    } satisfies ConnectorClient["requirements"]);
    this.forges = Object.freeze({
      list: (forge, path, query) => this.forge(forge).list(path, query),
      get: (identity) => this.forge(identity.forge).get(identity),
      comments: async (identity) => {
        const connector = this.forge(identity.forge);
        if (!connector.comments) throw new Error("Connector does not support comments");
        return connector.comments(identity);
      },
    } satisfies ConnectorClient["forges"]);
  }

  static fromConfig(config: { environments?: Record<string, unknown>; requirements?: Record<string, unknown>; forges?: Record<string, unknown> }): Connectors {
    return new Connectors(createMeegoRequirementConnectors(config), createForgeConnectors(config), new Environments(config.environments));
  }

  async describe() {
    return {
      environments: await this.environments.list(),
      requirements: this.requirementProviders.map(({ source, provider }) => ({ source, provider })),
      forges: this.forgeProviders.map(({ forge, provider }) => ({ forge, provider })),
    };
  }

  private requirement(source: string): RequirementConnector {
    const connector = this.requirementProviders.find((item) => item.source === source);
    if (!connector) throw new Error(`Unknown requirement connector: ${source}`);
    return connector;
  }

  private forge(forge: string): ForgeConnector {
    const connector = this.forgeProviders.find((item) => item.forge === forge);
    if (!connector) throw new Error(`Forge ${forge} is not configured with credentials`);
    return connector;
  }
}
