import type { PluginPackage, Resource } from "@compforge/aide-plugin";
const plugin: PluginPackage = {
  pluginId: "tests/printer", version: "1.0.0",
  async activate(context) {
    context.controllers.register<{ operation?: string; input?: Resource }, { done?: boolean; result?: unknown }>({
      resourceType: { apiVersion: "tests.aide.dev/v1alpha1", kind: "Printable" },
      async reconcile(_execution, request) {
        if (request.spec.operation !== "print" || request.status.done) return;
        const resource = request.spec.input!;
        await context.resources.patchStatus(request, { done: true, result: {
          description: await context.printers.describe(resource), summary: await context.printers.summarize(resource),
        } });
      },
    });
    if (context.instance.config.failActivation) throw new Error("Printer activation failed");
  },
};
export default plugin;
