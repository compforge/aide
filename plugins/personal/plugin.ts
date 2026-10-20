import type { PluginPackage } from "@compforge/aide-plugin";
import { registerConversations } from "./conversation/reconcile.ts";
import { registerInputRouting } from "./input.ts";
import { registerEnvironmentSources } from "./environment-source.ts";
import { registerSources } from "./source.ts";
import { registerMessageSources } from "./message-source.ts";
import { registerTasks } from "./task/reconcile.ts";
import { registerRoutines } from "./routine/reconcile.ts";

const plugin: PluginPackage = {
  pluginId: "aide.personal", version: "0.1.0",
  async activate(context) {
    context.logger.info("Personal Plugin worker activated", { attributes: { pid: process.pid } });
    registerInputRouting(context);
    registerConversations(context);
    registerSources(context);
    registerMessageSources(context);
    registerEnvironmentSources(context);
    registerTasks(context);
    registerRoutines(context);
  },
};
export default plugin;
