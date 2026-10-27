import { z } from "zod";
import type { ConnectorDefinition } from "@compforge/aide-connector";
import { EnvironmentKind, EnvironmentVersion, type EnvironmentDirectory } from "@compforge/aide-connector/environment";
import { MessageKind, MessageVersion, type MessageConnector } from "@compforge/aide-connector/message";
import { forgeDefinition } from "./forge/definition.ts";
import { resolveEnvironmentConfig } from "./environments/config.ts";
import { Environments } from "./environments.ts";
import { LarkMessagesConfigSchema } from "./lark/config.ts";
import { LarkMessages } from "./lark/messages.ts";

/** Built-in defaults implement a kind/version. Explicit name registrations take precedence. */
export function builtinDefinitions(): readonly ConnectorDefinition[] {
  const environments: ConnectorDefinition<ReturnType<typeof resolveEnvironmentConfig>, EnvironmentDirectory> = {
    kind: EnvironmentKind, version: EnvironmentVersion,
    config: { parse: value => resolveEnvironmentConfig(z.record(z.string(), z.unknown()).parse(value)) },
    create(_context, config) {
      const directory = new Environments(config);
      return { handlers: { list: () => directory.list(), get: (_call, name) => directory.get(name), workloads: (_call, name, namespace) => directory.workloads(name, namespace) } };
    },
  };
  const messages: ConnectorDefinition<z.infer<typeof LarkMessagesConfigSchema>, MessageConnector> = {
    kind: MessageKind, version: MessageVersion, config: LarkMessagesConfigSchema,
    create(_context, config) {
      if (!config.appId || !config.userId) throw new Error("Lark appId and userId are required");
      const reader = new LarkMessages({ appId: config.appId, userId: config.userId, timeoutMs: config.timeoutMs });
      return { metadata: { provider: "lark", accountId: config.appId, userId: config.userId }, handlers: {
        identity: () => reader.identity(), search: (_call, query) => reader.search(query),
        history: (_call, query) => reader.history(query), thread: (_call, query) => reader.thread(query),
      } };
    },
  };
  return [forgeDefinition, environments, messages];
}
