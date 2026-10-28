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
        capabilities: ["controllers"],
        runtime: { isolated: true },
      },
    });
    context.controllers.register<{ operation?: string; blockMs?: number }, { done?: boolean; result?: unknown; error?: string }>({
      resourceType: PROCESS_RESOURCE_TYPE,
      async reconcile(execution, resource) {
        if (resource.status.done) return;
        const operation = resource.spec.operation;
        if (!operation) {
          const deadline = Date.now() + Number(resource.spec.blockMs ?? 0);
          while (Date.now() < deadline) { /* Deliberately block the Runner only. */ }
          return;
        }
        const probe = async () => {
          if (operation === "capacity-wait") {
            const result = await execution.verbs.action("wait", {});
            if (result.state !== "success") throw new Error("Capacity probe verb failed");
            return "resumed";
          }
          if (operation === "capacity-step") {
            await new Promise(resolve => setTimeout(resolve, 50));
            return "step completed";
          }
          if (operation === "no-builtins") {
            const rejected: string[] = [];
            for (const kind of ["Input", "Output", "Turn", "Session", "Target", "SessionTargetBinding"]) {
              try { await context.resources.list({ apiVersion: ["Input", "Task", "Routine", "Topic"].includes(kind) ? "aide.dev/v1alpha2" : "aide.dev/v1alpha1", kind }); }
              catch (error) { if (!String(error).includes("Unknown resource definition")) throw error; rejected.push(kind); }
            }
            return rejected;
          }

          if (operation === "execution-context") {
            return Object.keys(execution).sort();
          }
          if (operation === "data-dirs") {
            return context.dataDirs;
          }
          if (operation === "crash") {
            process.exit(17);
          }
          if (operation === "resource-ref") {
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
          return { currentUid: current?.metadata.uid, ...(replacement ? { replacement } : {}) };
        }
        const durationMs = Number.parseInt(operation, 10);
        const deadline = Date.now() +
          (Number.isFinite(durationMs) ? durationMs : 200);
        while (Date.now() < deadline) {
          // Deliberately occupy the Runner event loop.
        }
        return "Runner completed blocking work";
        };
        try {
          const result = await probe();
          await context.resources.patchStatus(resource, { done: true, result });
        } catch (error) {
          await context.resources.patchStatus(resource, { done: true, error: String(error) });
        }
      },
    });
    context.hooks.register({
      hookId: "process-input",
      stage: "harness.input",
      async run(hook) {
        context.logger.info("Process Hook observed input", {
          component: "hook",
          attributes: { inputId: hook.subject.invocationId },
        });

        if (hook.subject.invocationId === "blocked-hook") {
          const deadline = Date.now() + 2000;
          while (Date.now() < deadline) { /* Exercise the generic Hook watchdog. */ }
        }
        if (hook.subject.invocationId !== "say-from-hook") return;
        await hook.verbs.action("notify", { text: "Continue from Hook?" });
      },
    });
    context.hooks.register({
      hookId: "process-output",
      stage: "harness.output",
      async run(hook) {
        if (hook.subject.kind !== "agent_message") return;
        await hook.verbs.action("notify", { text: "Continue outbound publication?" });
      },
    });
    context.controllers.register({
      resourceType: {
        apiVersion: "tests.aide.dev/v1alpha1",
        kind: "Review",
      },
      async reconcile(ctx, resource) {
        await ctx.verbs.action("notify", { text: `Review ${resource.metadata.name}?` });
      },
    });
  },
};

export default plugin;
