import type { PluginPackage } from "@compforge/aide-plugin";

const plugin: PluginPackage = {
  pluginId: "tests/environment-plugin",
  version: "1.0.0",
  async activate(context) {
    context.commands.register({
      name: `environment-${context.instance.pluginInstanceId}`,
      description: "Discover host-owned connectors from an unrelated plugin",
      async execute(input) {
        if (input.argument === "missing") await context.connectors.environments.get("missing");
        return { kind: "message", text: JSON.stringify({
          catalog: await context.connectors.describe(),
          environments: await context.connectors.environments.list(),
          environment: await context.connectors.environments.get("开发"),
          requirements: await context.connectors.requirements.list("work"),
          requirement: await context.connectors.requirements.get({ source: "work", category: "story", id: "1" }),
          pulls: await context.connectors.forges.list("forge", "org/repo", { state: "open", limit: 10 }),
          pull: await context.connectors.forges.get({ forge: "forge", path: "org/repo", number: 1 }),
          comments: await context.connectors.forges.comments({ forge: "forge", path: "org/repo", number: 1 }),
        }) };
      },
    });
  },
};
export default plugin;
