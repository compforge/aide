import {
  PluginBinding,
} from "../package.ts";
import {
  hookScope,
} from "../../../plugin/context.ts";
import type { PluginRunnerClient } from "./client.ts";
import type {
  HookRegistration,
  PluginRegistration } from "../../../protocol/ipc.ts";

/** Installs one Runner protocol registration into its Plugin Binding. */
export function installRegistration(
  binding: PluginBinding,
  runner: PluginRunnerClient,
  registration: PluginRegistration,
): void {
  if (registration.kind === "hook") {
    installHook(binding, runner, registration);
    return;
  }
  throw new Error("Controller registrations belong to the Runner runtime");
}

function installHook(
  binding: PluginBinding,
  runner: PluginRunnerClient,
  registration: HookRegistration,
): void {
  binding.hooks.register({
    hookId: registration.hookId,
    stage: registration.stage,
    ...(registration.timeoutMs === undefined
      ? {}
      : { timeoutMs: registration.timeoutMs }),
    run: async (context) =>
      await runner.invoke(
        registration.handlerId,
        context.stage,
        context.subject,
        context.snapshot,
        hookScope(context),
      ),
  });
}
