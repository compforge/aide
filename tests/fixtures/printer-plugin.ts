import type { PluginPackage, ResourcePrinter } from "@compforge/aide-plugin";

const TYPE = { apiVersion: "tests.aide.dev/v1alpha1", kind: "Printable" };
const plugin: PluginPackage = {
  pluginId: "tests/printer", version: "1.0.0",
  async activate(context) {
    const printer: ResourcePrinter<{ value: string }, { phase: string }> = {
      resourceType: TYPE,
      describe(resource) {
        if (resource.spec.value === "throw") throw new Error("Printer could not describe this value");
        if (resource.spec.value === "invalid") return 42 as unknown as string;
        if (resource.spec.value === "async") return Promise.resolve("late") as unknown as string;
        if (resource.spec.value === "block") {
          const end = Date.now() + 5000;
          while (Date.now() < end) { /* Exercise the existing Runner watchdog. */ }
        }
        return JSON.stringify({ instance: context.instance.pluginInstanceId, pid: process.pid,
          name: resource.metadata.name, value: resource.spec.value, phase: resource.status.phase });
      },
      summarize(resource) { return `${context.instance.pluginInstanceId}: ${resource.spec.value}`; },
    };
    context.printers.register(printer);
    if (context.instance.config.duplicate) context.printers.register(printer);
    if (context.instance.config.failActivation) throw new Error("Printer activation failed");
  },
};
export default plugin;
