import {
  PluginBinding,
} from "../package.ts";
import {
  hookScope,
} from "../../../plugin-context.ts";
import type { PluginRunnerClient } from "./client.ts";
import type {
  CommandRegistration,
  HookRegistration,
  MentionRegistration,
  PluginRegistration,
} from "../../../protocol/ipc.ts";

/** Installs one Runner protocol registration into its Plugin Binding. */
export function installRegistration(
  binding: PluginBinding,
  runner: PluginRunnerClient,
  registration: PluginRegistration,
): void {
  if (registration.kind === "command") {
    installCommand(binding, runner, registration);
    return;
  }
  if (registration.kind === "mention") {
    installMention(binding, runner, registration);
    return;
  }
  if (registration.kind === "hook") {
    installHook(binding, runner, registration);
    return;
  }
  throw new Error("Controller registrations belong to the Runner runtime");
}

function installCommand(
  binding: PluginBinding,
  runner: PluginRunnerClient,
  registration: CommandRegistration,
): void {
  binding.commands.register({
    input: registration.input,
    aliases: registration.aliases,
    runPolicy: registration.runPolicy,
    scope: registration.scope,
    name: registration.name,
    description: registration.description,
    execute: async (input, context) =>
      await runner.invokeCommand(
        registration.handlerId,
        input,
        context,
      ),
  });
}

function installMention(
  binding: PluginBinding,
  runner: PluginRunnerClient,
  registration: MentionRegistration,
): void {
  binding.mentions.register({
    namespace: registration.namespace,
    search: async (query) =>
      await runner.invoke(
        registration.searchHandlerId,
        query,
      ),
    resolve: async (id, options) =>
      await runner.invoke<string | undefined>(
        registration.resolveHandlerId,
        id,
        options,
      ),
  });
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
