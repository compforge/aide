import type { ConnectorsConfig } from "../connectors/config.ts";
import { LarkMessagesConfigSchema } from "../connectors/lark/config.ts";
import { resolveEnvironmentConfig } from "../connectors/environments/config.ts";

/** Personal's existing message and environment Sources each select one configured directory/account. */
export function personalConnectorConfig(config: ConnectorsConfig = {}) {
  const entries = Object.entries(config).filter(([, c]) => c.enabled !== false && c.version === "v1");
  const select = (kind: string) => {
    const matches = entries.filter(([, c]) => c.kind === kind);
    if (matches.length > 1) return undefined;
    return matches[0]?.[1].config;
  };
  const messages = select("messages");
  return {
    lark: messages ? LarkMessagesConfigSchema.parse(messages) : undefined,
    environments: resolveEnvironmentConfig(select("environment")),
    requirements: Object.fromEntries(entries.filter(([, c]) => c.kind === "requirement").map(([name, c]) => [name, c.config])),
  };
}
