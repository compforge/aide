import type { Logger } from "pino";
import type { Controller, ResourceClient } from "./api/index.ts";
import type { PluginInstance } from "./instance.ts";

export interface PluginContext {
  readonly instance: PluginInstance;
  readonly resources: ResourceClient;
  readonly log: Logger;
  readonly signal: AbortSignal;
  registerController<TSpec, TStatus>(controller: Controller<TSpec, TStatus>): void;
  onClose(cleanup: () => void | Promise<void>): void;
}

/** An immutable definition; one activation creates one binding and owns all registrations. */
export interface PluginPackage {
  readonly pluginId: string;
  readonly version: string;
  activate(context: PluginContext): void | Promise<void>;
}

export class PluginBinding {
  readonly abort = new AbortController();
  private readonly cleanup: Array<() => void | Promise<void>> = [];
  private closing?: Promise<void>;
  private sealed = false;

  assertRegistering(): void {
    if (this.abort.signal.aborted) throw new Error("Plugin binding is closed");
    if (this.sealed) throw new Error("Plugin activation is complete");
  }

  completeActivation(): void { this.assertRegistering(); this.sealed = true; }

  onClose(cleanup: () => void | Promise<void>): void {
    this.assertRegistering();
    this.cleanup.push(cleanup);
  }

  close(): Promise<void> {
    return this.closing ??= this.dispose();
  }

  private async dispose(): Promise<void> {
    this.abort.abort();
    const errors: unknown[] = [];
    for (const cleanup of this.cleanup.reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Plugin binding cleanup failed");
  }
}
