import { resolve } from "node:path";
import { CoreSession, type CoreControllerOptions, type CorePluginOptions } from "../core/index.ts";
import { SessionStore } from "../store/store.ts";
import type { ResourceType } from "@compforge/aide-plugin";
import { PluginInstanceStore } from "../plugin/instance.ts";

/**
 * @spec One application runtime owns plugin activation and resource scheduling, independent of conversations.
 * @tmp text=`Ledger and adapter bindings use the private CoreSession backend while its execution journal is extracted.`
 * @why Resource ownership and scheduling must not depend on the execution journal layout.
 * @link docs/kernel.md
 */
export class ApplicationRuntime {
  private readonly execution;
  private readonly backend: CoreSession;
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
    controller: Omit<CoreControllerOptions, "resolveTarget">;
    plugins: Omit<CorePluginOptions, "instances" | "resourceDirectory" | "resourceHome">;
  }) {
    const store = new SessionStore(home);
    const id = "aide:execution";
    this.execution = store.listSessions().some((s) => s.aideSessionId === id)
      ? store.openSession(id) : store.createSession({ id, cwd: options.cwd, title: "Aide execution journal" });
    this.targets = options.targets.map((target) => ({ ...target }));
    const instances = new PluginInstanceStore({ session: this.execution });
    this.backend = new CoreSession({
      session: this.execution,
      controller: { ...options.controller, resolveTarget: (id) => this.targets.find((t) => t.id === id) },
      plugins: { ...options.plugins, instances, resourceHome: home, harnessTargets: this.targets },
    });
    for (const declaration of options.instances) {
      if (!instances.list().some((i) => i.pluginInstanceId === declaration.pluginInstanceId)) {
        instances.create(declaration);
      }
      instances.replaceConfig(declaration.pluginInstanceId, declaration.config);
    }
    const cwd = resolve(options.cwd);
    if (this.execution.meta.cwd !== cwd) {
      this.execution.updateMeta({ cwd, lanes: Object.fromEntries(Object.entries(this.execution.meta.lanes).map(([key, lane]) =>
        [key, { ...lane, harnessSessions: {} }])), harnessSessions: {} });
    }
    for (const target of this.targets) this.registerTarget(target);
  }
  registerTarget(target: { id: string; harness: string; model?: string; effort?: string }) {
    const previous = this.execution.meta.harnessTargets[target.id];
    if (previous && previous.harness !== target.harness) {
      this.execution.updateMeta({ lanes: Object.fromEntries(Object.entries(this.execution.meta.lanes).map(([key, lane]) => {
        const { [target.id]: _old, ...harnessSessions } = lane.harnessSessions;
        return [key, { ...lane, harnessSessions }];
      })), harnessSessions: {} });
    }
    if (!this.targets.some((t) => t.id === target.id)) this.targets.push(target);
    this.execution.setHarnessTarget(target.id, { ...target, harnessTargetId: target.id });
  }
  enqueue(pluginInstanceId: string, type: ResourceType, name: string): Promise<void> {
    return this.plugins.enqueue({ aideSessionId: this.execution.id, pluginInstanceId, namespace: "v1",
      resourceApiVersion: type.apiVersion, resourceKind: type.kind, resourceId: name });
  }

  get plugins() { return this.backend.pluginManager!; }
  get projection() { return this.backend.projection; }
  get id() { return this.execution.id; }
  subscribe(listener: () => void) { return this.backend.subscribe(listener); }
  start() { return this.backend.start(); }
  close() { return this.backend.close(); }
  resolveApproval(...args: Parameters<CoreSession["resolveApproval"]>) { return this.backend.resolveApproval(...args); }
}
