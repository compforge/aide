import { connectorConfigPath } from "./config.ts";
import { createForgeConnectors } from "./forge/config.ts";
import { createMeegoRequirementConnectors } from "./requirements/meego.ts";
import type { RequirementConnector, RequirementIdentity } from "./requirements/protocol.ts";
import type { ForgeConnector, PullRequestIdentity } from "./forge/protocol.ts";

/** Provider access is shared by Source and Chief; neither depends on provider DTOs. */
export class Connectors {
  constructor(readonly requirements: readonly RequirementConnector[], readonly forges: readonly ForgeConnector[]) {}
  static load(path = connectorConfigPath()): Connectors {
    return new Connectors(createMeegoRequirementConnectors(path), createForgeConnectors(path));
  }
  requirement(source: string): RequirementConnector {
    const connector = this.requirements.find((item) => item.source === source);
    if (!connector) throw new Error(`Unknown requirement connector: ${source}`);
    return connector;
  }
  forge(forge: string): ForgeConnector {
    const connector = this.forges.find((item) => item.forge === forge);
    if (!connector) throw new Error(`Forge ${forge} is not configured with credentials`);
    return connector;
  }
  readRequirement(identity: RequirementIdentity) { return this.requirement(identity.source).get(identity); }
  readPullRequest(identity: PullRequestIdentity) { return this.forge(identity.forge).get(identity); }
}
