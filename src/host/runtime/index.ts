import { resolve } from "node:path";
import { ExecutionService, type ExecutionOptions } from "./execution.ts";
import { Manager, type ManagerOptions } from "../plugin/manager.ts";
import { createReconcileSnapshot } from "../plugin/reconcile-snapshot.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RuntimeLogger } from "../logging.ts";
import type { ResourceType } from "@compforge/aide-plugin";
import { PluginInstanceStore } from "../plugin/instance.ts";

/**
 * @spec One application runtime owns plugin activation and resource scheduling, independent of conversations.
 * @why Resource ownership and scheduling must not depend on the execution journal layout.
 * @link docs/kernel.md
 */
export class ApplicationRuntime {
  private readonly logger: RuntimeLogger;
  readonly executions: ExecutionService;
  readonly plugins: Manager;
  private closing?: Promise<void>;
  readonly targets: { id: string; harness: string; model?: string; effort?: string }[];
  constructor(home: string, options: {
    cwd: string;
    targets: { id: string; harness: string; model?: string; effort?: string }[];
    instances: readonly {
      pluginInstanceId: string;
      pluginId: string;
      packageVersion: string;
      marketplace?: string;
      config: Record<string, unknown>;
    }[];
    controller: Omit<ExecutionOptions, "resolveTarget" | "hooks">;
    plugins: Omit<ManagerOptions, "instances" | "resourceHome" | "harness" | "snapshot" | "harnessTargets">;
  }) {
    mkdirSync(home, { recursive: true });
    this.logger = new RuntimeLogger(join(home, "runtime.log"), "runtime");
    this.targets = options.targets.map((target) => ({ ...target }));
    try {
      this.executions = new ExecutionService(home, { ...options.controller, cwd: options.cwd, targets: options.targets,
        selectedHarnessTargetId: options.plugins.selectedHarnessTargetId,
        resolveTarget: id => this.targets.find(target => target.id === id),
        hooks: {
          has: stage => this.plugins?.hasHook(stage) ?? false,
          inline: (stage, subject) => this.plugins?.inlineHook(stage, subject) ?? Promise.resolve(),
          defer: (stage, subject) => this.plugins?.deferHook(stage, subject),
        },
      });
    } catch (error) {
      void this.logger.close().catch(() => {});
      throw error;
    }
    try {
      const instances = new PluginInstanceStore({ home });
      for (const declaration of options.instances) {
        if (!instances.list().some((i) => i.pluginInstanceId === declaration.pluginInstanceId)) {
          instances.create(declaration);
        }
        instances.replaceConfig(declaration.pluginInstanceId, declaration.config);
      }
      const cwd = resolve(options.cwd);
      this.plugins = new Manager({ ...options.plugins, instances, resourceHome: home, harness: this.executions,
        log: options.plugins.log ?? (entry => this.logger.log(entry)),
        snapshot: () => createReconcileSnapshot({ cwd, harnessTargets: this.targets }),
      });
    } catch (error) {
      // Startup has no admitted plugin work. Cleanup must release the journal
      // even when Manager validation fails, without hiding the original error.
      void this.executions.close().finally(() => this.logger.close()).catch(() => {});
      throw error;
    }
  }
  registerTarget(target: { id: string; harness: string; model?: string; effort?: string }) {
    const index = this.targets.findIndex(t => t.id === target.id);
    if (index < 0) this.targets.push({ ...target });
    else this.targets[index] = { ...target };
    this.executions.registerTarget(target);
  }
  enqueue(pluginInstanceId: string, type: ResourceType, name: string): Promise<void> {
    return this.plugins.enqueue({ pluginInstanceId, namespace: "v1",
      resourceApiVersion: type.apiVersion, resourceKind: type.kind, resourceId: name });
  }

  subscribe(listener: () => void) { return this.executions.subscribe(listener); }
  start() { return this.plugins.start(); }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      const results = [];
      // Stop resource owners before closing the capability they may still be awaiting.
      for (const close of [() => this.plugins.close(), () => this.executions.close(), () => this.logger.close()]) {
        try { await close(); } catch (reason) { results.push({ status: "rejected" as const, reason }); }
      }
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Could not close application runtime");
    })();
  }
}
