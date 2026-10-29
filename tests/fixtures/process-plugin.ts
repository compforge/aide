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
              try { await context.resources.list({ apiVersion: ["Task", "Routine", "Topic"].includes(kind) ? "aide.dev/v1alpha3" : ["Input", "Person"].includes(kind) ? "aide.dev/v1alpha2" : "aide.dev/v1alpha1", kind }); }
              catch (error) { if (!String(error).includes("Unknown resource definition")) throw error; rejected.push(kind); }
            }
            return rejected;
          }

          if (operation === "page-contract") {
            const entries = [];
            for (const name of ["page-a", "page-b", "page-c"]) entries.push(await context.resources.create(PROCESS_RESOURCE_TYPE,
              { name, labels: { probe: "pages" }, spec: {}, status: {} }));
            const options = { limit: 1, matchLabels: { probe: "pages" } };
            const first = await context.resources.listPage(PROCESS_RESOURCE_TYPE, options);
            const second = await context.resources.listPage(PROCESS_RESOURCE_TYPE, { ...options, limit: 2, continue: first.metadata.continue });
            let invalid = "", expired = "";
            try { await context.resources.listPage(PROCESS_RESOURCE_TYPE, { limit: 1, continue: first.metadata.continue }); }
            catch (error) { invalid = (error as Error).name; }
            await context.resources.patchStatus(entries[0]!, { changed: true });
            try { await context.resources.listPage(PROCESS_RESOURCE_TYPE, { ...options, continue: first.metadata.continue }); }
            catch (error) { expired = (error as Error).name; }
            return { names: [...first.items, ...second.items].map(r => r.metadata.name), end: second.metadata.continue,
              sameVersion: first.metadata.resourceVersion === second.metadata.resourceVersion, invalid, expired };
          }
          if (operation === "patch-contract") {
            const original = await context.resources.patch(resource, { type: "merge", value: { status: { left: 1, right: 1 } } });
            await context.resources.patch(original, { type: "merge", value: { status: { right: 2 } } });
            await context.resources.patch(original, { type: "json", value: [
              { op: "test", path: "/status/left", value: 1 }, { op: "replace", path: "/status/left", value: 2 },
              { op: "add", path: "/status/literal", value: null },
            ] });
            let testError = "", lockError = "";
            try { await context.resources.commit([
              { operation: "patchStatus", resource, patch: { right: 9 } },
              { operation: "patch", resource, patch: { type: "json", value: [{ op: "test", path: "/status/left", value: 1 }] } },
            ]); } catch (error) { testError = (error as Error).name; }
            try { await context.resources.patchStatus(original, { done: false }, { resourceVersion: original.metadata.resourceVersion }); }
            catch (error) { lockError = (error as Error).name; }
            const current = await context.resources.get<unknown, Record<string, unknown>>({ ...resource, ...resource.metadata });
            return { left: current!.status.left, right: current!.status.right, literal: current!.status.literal, testError, lockError };
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
          await context.resources.patch(resource, { type: "json", value: [
            { op: "add", path: "/status/done", value: true }, { op: "add", path: "/status/result", value: result },
          ] });
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
