import type { PluginPackage } from "@compforge/aide-plugin";
const TYPE = { apiVersion: "tests.aide.dev/v1alpha1", kind: "ProcessCheck" };
const plugin: PluginPackage = {
  pluginId: "tests/diagnostics", version: "1.0.0",
  async activate(context) {
    context.controllers.register<{ mode: string }, { done?: boolean }>({ resourceType: TYPE, maxConcurrency: 2,
      async reconcile(_execution, resource) {
        if (resource.status.done) return;
        await context.resources.get({ ...TYPE, ...resource.metadata });
        context.logger.info("Diagnostic fixture stage", { attributes: { name: resource.metadata.name } });
        if (resource.spec.mode === "wait") await context.resources.list(TYPE);
        if (resource.spec.mode === "cpu") {
          const until = Date.now() + 1500;
          while (Date.now() < until) { /* Host must still be able to report and terminate this Runner. */ }
        }
        await context.resources.patchStatus(resource, { done: true });
      },
    });
  },
};
export default plugin;
