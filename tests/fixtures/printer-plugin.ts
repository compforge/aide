import type { PluginPackage, Resource } from "@compforge/aide-plugin";
const plugin: PluginPackage = {
  pluginId: "tests/printer", version: "1.0.0",
  async activate(context) {
    context.commands.register({
      name: "print-resource", description: "Render a supplied resource through the Plugin context",
      async execute(input) {
        const resource = JSON.parse(input.argument) as Resource;
        return { kind: "message", text: JSON.stringify({
          description: await context.printers.describe(resource), summary: await context.printers.summarize(resource),
        }) };
      },
    });
    if (context.instance.config.failActivation) throw new Error("Printer activation failed");
  },
};
export default plugin;
