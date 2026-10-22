import type { PluginPackage } from "@compforge/aide-plugin";

const PROCESS_RESOURCE_TYPE = {
  apiVersion: "tests.aide.dev/v1alpha1",
  kind: "ProcessCheck",
} as const;

const plugin: PluginPackage = {
  pluginId: "tests/process-plugin",
  version: "1.0.0",
  async activate(context) {
    context.logger.info("Process Plugin activated", {
      component: "lifecycle",
      attributes: {
        capabilities: ["commands"],
        runtime: { isolated: true },
      },
    });
    context.commands.register({
      name: "process-check",
      description: "Exercise Plugin Runner process isolation",
      async execute(input, command) {
        if (input.argument === "no-builtins") {
          const rejected: string[] = [];
          for (const kind of ["Input", "Output", "Turn", "Session", "Target", "SessionTargetBinding"]) {
            try { await context.resources.list({ apiVersion: "aide.dev/v1alpha1", kind }); }
            catch (error) { if (!String(error).includes("Unknown resource definition")) throw error; rejected.push(kind); }
          }
          return { kind: "message", text: JSON.stringify(rejected) };
        }

        if (input.argument === "submit") {
          await command.verbs.configureModel({ model: "fast", effort: "medium" });
          const receipt = await command.verbs.submit({ prompt: "task" });
          return { kind: "message", text: JSON.stringify({ command: command.command, target: command.target, receipt }) };
        }
        if (input.argument === "data-dirs") {
          return {
            kind: "message",
            text: JSON.stringify(context.dataDirs),
          };
        }
        if (input.argument === "crash") {
          process.exit(17);
        }
        if (input.argument === "resource-ref") {
          const created = await context.resources.create(
            PROCESS_RESOURCE_TYPE,
            {
              name: "resource_ref",
              spec: { value: "runner" },
            },
          );
          const ref = {
            ...PROCESS_RESOURCE_TYPE,
            namespace: created.metadata.namespace,
            name: created.metadata.name,
            uid: created.metadata.uid,
          };
          const current = await context.resources.get(ref);
          const replacement = await context.resources.get({
            ...ref,
            uid: "replacement_uid",
          });
          return {
            kind: "message",
            text: JSON.stringify({
              currentUid: current?.metadata.uid,
              replacement,
            }),
          };
        }
        const durationMs = Number.parseInt(input.argument, 10);
        const deadline = Date.now() +
          (Number.isFinite(durationMs) ? durationMs : 200);
        while (Date.now() < deadline) {
          // Deliberately occupy the Runner event loop.
        }
        return {
          kind: "message",
          text: "Runner completed blocking work",
        };
      },
    });
    context.hooks.register({
      hookId: "process-input",
      stage: "view.input",
      async run(hook) {
        context.logger.info("Process Hook observed input", {
          component: "hook",
          attributes: { inputId: hook.subject.inputId },
        });

        if (hook.subject.input.kind !== "prompt" || hook.subject.input.text !== "say from hook") return;
        await hook.verbs.action("notify", { text: "Continue from Hook?" });
      },
    });
    context.hooks.register({
      hookId: "process-output",
      stage: "view.output",
      async run(hook) {
        if (hook.subject.kind !== "transcript") return;
        await hook.verbs.action("notify", { text: "Continue outbound publication?" });
      },
    });
    context.controllers.register<{ blockMs?: number }, Record<string, never>>({
      resourceType: PROCESS_RESOURCE_TYPE,
      async reconcile(_execution, resource) {
        const delay = Number(resource.spec.blockMs ?? 0);
        const deadline = Date.now() + delay;
        while (Date.now() < deadline) { /* Occupy only the Runner event loop. */ }
      },
    });
    context.controllers.register({
      resourceType: {
        apiVersion: "tests.aide.dev/v1alpha1",
        kind: "Review",
      },
      async reconcile(ctx, turn) {
        await ctx.verbs.action("notify", { text: `Review ${turn.metadata.name}?` });
      },
    });
  },
};

export default plugin;
