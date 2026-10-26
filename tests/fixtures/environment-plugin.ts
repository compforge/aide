import type { PluginPackage } from "@compforge/aide-plugin";

const plugin: PluginPackage = {
  pluginId: "tests/environment-plugin",
  version: "1.0.0",
  async activate(context) {
    context.controllers.register<{ operation: string }, { done?: boolean; result?: unknown; error?: string }>({
      resourceType: { apiVersion: "tests.aide.dev/v1alpha1", kind: "EnvironmentCheck" },
      async reconcile(_execution, resource) {
        if (resource.status.done) return;
        try {
        if (resource.spec.operation === "missing") await context.connectors.environments.get("missing");
        const result = {
          catalog: await context.connectors.describe(),
          environments: await context.connectors.environments.list(),
          environment: await context.connectors.environments.get("开发"),
          requirements: await context.connectors.requirements.list("work"),
          requirementAccount: await context.connectors.requirements.identity("work"),
          requirementComments: await context.connectors.requirements.comments({ source: "work", category: "story", id: "1" }),
          requirement: await context.connectors.requirements.get({ source: "work", category: "story", id: "1" }),
          pulls: await context.connectors.forges.list("forge", "org/repo", { state: "open", limit: 10 }),
          pull: await context.connectors.forges.get({ repository: { forge: { name: "forge" }, path: "org/repo" }, number: 1 }),
          comments: await context.connectors.forges.comments({ repository: { forge: { name: "forge" }, path: "org/repo" }, number: 1 }),
        };
        await context.resources.patchStatus(resource, { done: true, result });
        } catch (error) { await context.resources.patchStatus(resource, { done: true, error: String(error) }); }
      },
    });
  },
};
export default plugin;
