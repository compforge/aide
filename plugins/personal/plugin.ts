import { registerRepositorySources } from "./source/repository/observe.ts";
import { registerPullRequestSources } from "./source/pull-request/observe.ts";
import { registerWeave } from "./weave/reconcile.ts";
import type { PluginPackage } from "@compforge/aide-plugin";
import { registerTopics } from "./topic/reconcile.ts";
import { registerRoute } from "./route/reconcile.ts";
import { registerEnvironmentSources } from "./source/environment/observe.ts";
import { registerSources } from "./source/requirement/observe.ts";
import { registerMessageSources } from "./source/message/observe.ts";
import { registerTasks } from "./task/reconcile.ts";
import { registerRoutines } from "./routine/reconcile.ts";
import { registerPersons } from "./person/reconcile.ts";

const plugin: PluginPackage = {
  pluginId: "aide.personal", version: "0.1.0",
  async activate(context) {
    context.logger.info("Personal Plugin worker activated", { attributes: { pid: process.pid } });
    registerWeave(context);
    registerRoute(context);
    registerTopics(context);
    registerSources(context);
    registerRepositorySources(context);
    registerPullRequestSources(context);
    registerMessageSources(context);
    registerEnvironmentSources(context);
    registerTasks(context);
    registerRoutines(context);
    registerPersons(context);
  },
};
export default plugin;
