import type { PluginPackage } from "@compforge/aide-plugin";
import { registerOutputs } from "../../plugins/personal/output/reconcile.ts";
export default { pluginId: "tests/output-frequency", version: "1.0.0", activate: async context => registerOutputs(context) } satisfies PluginPackage;
