import { resolve } from "node:path";
import { ExecutionService, type ExecutionOptions } from "./execution.ts";
import { Manager, type ManagerOptions } from "../plugin/manager.ts";
import { createReconcileSnapshot } from "../plugin/reconcile-snapshot.ts";
import { openExecutionJournal } from "../store/store.ts";
import type { ResourceType } from "@compforge/aide-plugin";
import { PluginInstanceStore } from "../plugin/instance.ts";

/**
 * @spec One application runtime owns plugin activation and resource scheduling, independent of conversations.
 * @why Resource ownership and scheduling must not depend on the execution journal layout.
 * @link docs/kernel.md
 */
export class ApplicationRuntime {
  private readonly execution;
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
    plugins: Omit<ManagerOptions, "instances" | "resourceHome" | "session" | "snapshot" | "harnessTargets" | "enqueueHarnessInvocation" | "cancelHarnessInvocation">;
  }) {
    this.execution = openExecutionJournal(home, options.cwd);
    this.targets = options.targets.map((target) => ({ ...target }));
    try {
      this.executions = new ExecutionService(this.execution, { ...options.controller,
        resolveTarget: id => this.targets.find(target => target.id === id),
        hooks: {
          has: stage => this.plugins?.hasHook(stage) ?? false,
          inline: (stage, subject) => this.plugins?.inlineHook(stage, subject) ?? Promise.resolve(),
          defer: (stage, subject) => this.plugins?.deferHook(stage, subject),
        },
      });
    } catch (error) {
      void this.execution.closeLogs().catch(() => {});
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
      if (this.execution.meta.cwd !== cwd) {
        this.execution.updateMeta({ cwd, contexts: Object.fromEntries(Object.entries(this.execution.meta.contexts).map(([key, lane]) =>
          [key, { ...lane, harnessSessions: {} }])), harnessSessions: {} });
      }
      for (const target of this.targets) this.registerTarget(target);
      this.plugins = new Manager({ ...options.plugins, instances, resourceHome: home, session: this.execution,
        snapshot: () => createReconcileSnapshot({ cwd: this.execution.meta.cwd, harnessTargets: this.targets }),
        enqueueHarnessInvocation: request => this.executions.enqueue(request),
        cancelHarnessInvocation: id => this.executions.cancel(id),
      });
    } catch (error) {
      // Startup has no admitted plugin work. Cleanup must release the journal
      // even when Manager validation fails, without hiding the original error.
      void this.executions.close().catch(() => {});
      throw error;
    }
  }
  registerTarget(target: { id: string; harness: string; model?: string; effort?: string }) {
    const previous = this.execution.meta.harnessTargets[target.id];
    if (previous && previous.harness !== target.harness) {
      this.execution.updateMeta({ contexts: Object.fromEntries(Object.entries(this.execution.meta.contexts).map(([key, lane]) => {
        const { [target.id]: _old, ...harnessSessions } = lane.harnessSessions;
        return [key, { ...lane, harnessSessions }];
      })), harnessSessions: {} });
    }
    const index = this.targets.findIndex(t => t.id === target.id);
    if (index < 0) this.targets.push({ ...target });
    else this.targets[index] = { ...target };
    this.execution.setHarnessTarget(target.id, { ...target, harnessTargetId: target.id });
  }
  enqueue(pluginInstanceId: string, type: ResourceType, name: string): Promise<void> {
    return this.plugins.enqueue({ pluginInstanceId, namespace: "v1",
      resourceApiVersion: type.apiVersion, resourceKind: type.kind, resourceId: name });
  }

  subscribe(listener: () => void) { return this.executions.subscribe(listener); }
  start() { return this.plugins.start(); }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      const results = await Promise.allSettled([this.plugins.close(), this.executions.close()]);
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Could not close application runtime");
    })();
  }
}
