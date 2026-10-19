import type { Logger } from "pino";
import type { ConnectorClient } from "@compforge/aide-plugin";
import { Personal } from "../plugins/personal/aide.ts";
import { parseWatches, validateWatchScopes } from "../plugins/personal/source-config.ts";
import { loadMeegoRequirementConfigs } from "../connectors/requirements/meego.ts";
import { Connectors } from "../connectors/index.ts";
import type { AideConfig } from "./config.ts";
import { CoreSession, type CoreControllerOptions } from "./host/core/index.ts";
import { SessionStore } from "./host/store/store.ts";
import { PluginInstanceStore } from "./host/plugin/instance.ts";
import { PluginSupervisor } from "./host/plugin/runner/index.ts";

export interface AideOptions {
  cwd: string; timezone: string; model?: string; config?: AideConfig; connectors?: ConnectorClient;
  createAdapter: CoreControllerOptions["createAdapter"];
}

/** Application composition chooses installed business plugins; Core owns their mechanisms. */
export class Aide extends Personal {
  constructor(home: string, options: AideOptions, log: Logger) {
    const config = options.config;
    const watches = parseWatches(config?.plugins.personal);
    validateWatchScopes(watches, loadMeegoRequirementConfigs(config?.connectors ?? {}));
    const connectors = options.connectors ?? Connectors.fromConfig(config?.connectors ?? {});
    const sessions = new SessionStore(home);
    const previous = sessions.listSessions({ cwd: options.cwd })[0];
    const session = previous ? sessions.openSession(previous.aideSessionId) : sessions.createSession({ cwd: options.cwd, title: "Aide" });
    const targets = [{ id: "default", harness: "codex" }];
    session.setHarnessTarget("default", { harnessTargetId: "default", harness: "codex", ...(options.model ? { model: options.model } : {}) });
    const instances = new PluginInstanceStore({ session });
    if (!instances.list().some((item) => item.pluginInstanceId === "personal")) {
      instances.create({ pluginInstanceId: "personal", pluginId: "aide.personal", packageVersion: "0.1.0", marketplace: "builtin" });
    }
    instances.replaceConfig("personal", { watches });
    const packages = new Map([["aide.personal@0.1.0", new URL("../plugins/personal/plugin.ts", import.meta.url).href]]);
    let application: Personal;
    const core = new CoreSession({ session,
      controller: { mentionBudgetChars: 0, createAdapter: options.createAdapter, resolveTarget: (id) => targets.find((item) => item.id === id) },
      plugins: { instances, connectors, harnessTargets: targets, selectedHarnessTargetId: () => "default",
        harnessInvocationGate: () => "auto_approve", pluginSupervisor: new PluginSupervisor(),
        loadPackageEntry: async (pluginId, version) => {
          const entryUrl = packages.get(`${pluginId}@${version}`);
          if (!entryUrl) throw new Error(`Plugin package is not installed: ${pluginId}@${version}`);
          return { pluginId, version, entryUrl };
        },
        onRunnerFailure: ({ error }) => {
          log.error({ err: error }, "Plugin Runner stopped");
          void application.recoverInterrupted().catch((err) => log.error({ err }, "Recovery failed"));
        },
      },
    });
    super(home, { timezone: options.timezone, chiefModel: config?.harnesses.chief.model }, log, { core, session, connectors, targets, watches });
    application = this;
  }
}
