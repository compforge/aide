import { z } from "zod";
import { ForgeMeSchema } from "./catalog.ts";
import { createForgeReader } from "@compforge/repocli";
import { ForgeKind, ForgeVersion, forgeImplementation, type ForgeOperations } from "@compforge/aide-connector/forge";
import type { ConnectorDefinition } from "@compforge/aide-connector";

const ConfigSchema = z.object({ provider: z.enum(["github", "gitlab"]), host: z.string().trim().min(1), forge: z.string().trim().min(1).optional(),
  tokenEnv: z.string().min(1).optional(), token: z.string().trim().min(1).optional(), me: ForgeMeSchema.optional() }).strict();
export const forgeDefinition: ConnectorDefinition<z.infer<typeof ConfigSchema>, ForgeOperations> = {
  kind: ForgeKind, version: ForgeVersion, config: ConfigSchema,
  create(context, config) {
    const token = config.tokenEnv ? context.env(config.tokenEnv) : config.provider === "github"
      ? context.env("GITHUB_TOKEN") || context.env("GH_TOKEN") : context.env("GITLAB_TOKEN");
    if (!token && !config.token) throw new Error("Forge credential is missing");
    const implementation = forgeImplementation(createForgeReader({ forge: config.forge ?? config.host, host: config.host, provider: config.provider, token: token ?? config.token! }, { signal: context.signal }));
    return { ...implementation, metadata: { ...implementation.metadata, ...(config.me ? { me: config.me } : {}) } };
  },
};
