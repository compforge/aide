import type { PluginPackage } from "@compforge/aide-plugin";
import { registerChief } from "./chief.ts";
import { registerEnvironmentSources } from "./environment-source.ts";
import { registerSources } from "./source.ts";
import { registerTasks } from "./task.ts";
import { registerRoutines } from "./routine.ts";

const plugin: PluginPackage = {
  pluginId: "aide.personal", version: "0.1.0",
  async activate(context) {
    context.logger.info("Personal Plugin worker activated", { attributes: { pid: process.pid } });
    registerChief(context);
    registerSources(context);
    registerEnvironmentSources(context);
    registerTasks(context);
    registerRoutines(context);
  },
};
export default plugin;
