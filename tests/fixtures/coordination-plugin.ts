import type { PluginPackage } from "@compforge/aide-plugin";
const task = { apiVersion: "aide.dev/v1alpha1", kind: "Task" };
const observation = { apiVersion: "tests.aide.dev/v1alpha1", kind: "WorkObserver" };
const namespace = "v1/project/coordination";
const plugin: PluginPackage = {
  pluginId: "tests/coordination", version: "1.0.0",
  async activate(context) {
    context.controllers.register({ resourceType: task, async reconcile() {} });
    context.controllers.register<{ conversationId: string }, { answer?: string; count?: number; revision?: number }>({
      resourceType: observation,
      sources: [{ type: "resource", sourceId: "unavailable", async start() { throw new Error("Fixture Source is unavailable"); } }, { type: "resource", sourceId: "observer", async start(source) { const resource = { name: "observer", namespace, spec: { conversationId: "group-a" } } as const; await source.emit(resource); await source.emit(resource); } }],
      watches: [{ resourceType: task, handler: {
        async create() { return [{ name: "observer", namespace }]; },
        async update() { return [{ name: "observer", namespace }]; },
        async delete() { return [{ name: "observer", namespace }]; },
      } }],
      async reconcile(execution, resource) {
        if (!Object.isFrozen(resource.spec) || !Object.isFrozen(execution.snapshot)) throw new Error("Reconcile snapshot must be immutable");
        const works = await context.resources.list(task);
        const current = () => context.resources.get<{ conversationId: string }, { answer?: string; count?: number; revision?: number }>({ ...observation, ...resource.metadata });
        if (!resource.status.answer && works.length) {
          const actions = execution.withContext({ conversationId: resource.spec.conversationId });
          await actions.verbs.connectors({ timeoutMs: 1000 }).describe();
          await actions.verbs.harness({ title: "检查", prompt: "Work: {}", timeoutMs: 10_000 });
          await context.resources.patchStatus((await current())!, { answer: "observed" });
        }
        await context.resources.patchStatus((await current())!, { count: works.filter((work) => !work.metadata.deletionTimestamp).length, revision: works[0]?.metadata.generation ?? 0 });
      },
    });
  },
};
export default plugin;
