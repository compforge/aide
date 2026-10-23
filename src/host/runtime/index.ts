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
 * @spec Harness is an optional capability; resource-only startup never opens its execution history.
 * @case tests/runtime.test.ts
 * @why Resource ownership and scheduling must not depend on the native session storage layout.
 * @link docs/kernel.md
 */
export class ApplicationRuntime {
  private readonly logger: RuntimeLogger;
  private readonly executionService?: ExecutionService;
  get executions(): ExecutionService {
    if (!this.executionService) throw new Error("Harness execution is not configured");
    return this.executionService;
  }
  readonly plugins: Manager;
  private closing?: Promise<void>;
  readonly targets: { id: string; harness: string; model?: string; effort?: string }[];
  constructor(home: string, options: {
    cwd: string;
    instances: readonly {
      pluginInstanceId: string;
      pluginId: string;
      packageVersion: string;
      marketplace?: string;
      config: Record<string, unknown>;
    }[];
    /** Optional capability; resource-only plugins need no adapter or execution storage. */
    harness?: Omit<ExecutionOptions, "resolveTarget" | "hooks"> & {
      targets: { id: string; harness: string; model?: string; effort?: string }[];
      defaultTargetId?: string;
    };
    plugins: Omit<ManagerOptions, "instances" | "resourceHome" | "harness" | "snapshot" | "harnessTargets">;
  }) {
    mkdirSync(home, { recursive: true });
    this.logger = new RuntimeLogger(join(home, "runtime.log"), "runtime");
    this.targets = (options.harness?.targets ?? []).map((target) => ({ ...target }));
    try {
      if (options.harness) this.executionService = new ExecutionService(home, { ...options.harness, cwd: options.cwd,
        defaultTargetId: options.harness.defaultTargetId,
        resources: id => this.plugins.resourceClient(id),
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
      this.plugins = new Manager({ ...options.plugins, instances, resourceHome: home, harness: this.executionService,
        log: options.plugins.log ?? (entry => this.logger.log(entry)),
        snapshot: () => createReconcileSnapshot({ cwd, harnessTargets: this.targets }),
      });
    } catch (error) {
      // Startup has no admitted plugin work. Cleanup must release the execution
      // even when Manager validation fails, without hiding the original error.
      void (this.executionService?.close() ?? Promise.resolve()).finally(() => this.logger.close()).catch(() => {});
      throw error;
    }
  }
  registerTarget(target: { id: string; harness: string; model?: string; effort?: string }) {
    const executions = this.executions;
    const index = this.targets.findIndex(t => t.id === target.id);
    if (index < 0) this.targets.push({ ...target });
    else this.targets[index] = { ...target };
    executions.registerTarget(target);
  }
  enqueue(pluginInstanceId: string, type: ResourceType, name: string): Promise<void> {
    return this.plugins.enqueue({ pluginInstanceId, namespace: "v1",
      resourceApiVersion: type.apiVersion, resourceKind: type.kind, resourceId: name });
  }

  subscribe(listener: () => void) { return this.executionService?.subscribe(listener) ?? (() => {}); }
  start() { return this.plugins.start(); }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      const results = [];
      // Stop resource owners before closing the capability they may still be awaiting.
      for (const close of [() => this.plugins.close(), () => this.executionService?.close(), () => this.logger.close()]) {
        try { await close(); } catch (reason) { results.push({ status: "rejected" as const, reason }); }
      }
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Could not close application runtime");
    })();
  }
}
