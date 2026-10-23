import { INPUT_TYPE, type InputSpec, type InputStatus } from "./input/model.ts";
import { resourceRef } from "./input/state.ts";
import type { PluginContext } from "@compforge/aide-plugin";
import { nextOccurrence, validateTrigger, type WorkStatus } from "./model.ts";
import { toWork, type WorkResource, type WorkSpec } from "./resources.ts";

/**
 * @spec Only Work Reconcile applies inbox requests. Observations never resume paused, completed or uncertain work.
 * @spec Request application and state commit together; contextual input remains pending until execution confirms it.
 * @link docs/plugin/personal.md
 */
export async function consumeWorkInputs(context: PluginContext, original: WorkResource): Promise<WorkResource | undefined> {
  const ref = { apiVersion: original.apiVersion, kind: original.kind, ...original.metadata };
  for (let attempt = 0; attempt < 20; attempt++) {
    const resource = await context.resources.get<WorkSpec, WorkStatus>(ref);
    if (!resource || resource.metadata.deletionTimestamp) return;
    const work = toWork(resource);
    // A running work must be recovered before consuming anything that could start it again.
    if (work.status === "running") return resource;
    const pending = await context.resources.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: "handlePending", value: resource.metadata.uid } });
    const unapplied = pending.filter(fact => !fact.status.handle![resource.metadata.uid]!.appliedAt);
    if (!unapplied.length) return resource;
    const receipts = [];
    for (const fact of unapplied) {
      const receipt = fact.status.handle![resource.metadata.uid]!;
      const input = { ...fact.spec, ...receipt.request, id: fact.metadata.name, at: fact.metadata.creationTimestamp };
      let rejection: string | undefined;
      try {
        if (input.action === "pause") { work.status = "paused"; work.nextAt = null; work.question = null; }
        else if (input.action === "resume" || input.action === "answer") {
          if (input.action === "answer" && work.status !== "waiting") throw new Error("answer requires waiting work");
          work.status = "ready"; work.nextAt = null; work.question = null;
        } else {
          if (input.action === "update") {
            const desired = { ...work, ...input.changes };
            validateTrigger(desired.kind, desired.trigger, new Date());
            Object.assign(work, input.changes);
          }
          if (["ready", "waiting", "scheduled"].includes(work.status) || (input.action === "update" && work.status === "done")) {
            const scheduled = input.action === "update" && work.kind === "routine";
            work.status = scheduled ? "scheduled" : "ready";
            work.nextAt = scheduled ? nextOccurrence(work.trigger, new Date()) : null;
            work.question = null;
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        rejection = reason;
        work.recent.push({ at: new Date().toISOString(), text: `Input ${input.id} rejected: ${reason}` });
        context.logger.warn("Work input rejected", { attributes: { workId: work.id, inputId: input.id, reason } });
      }
      const at = new Date().toISOString();
      const complete = !!rejection || input.action === "pause";
      if (!rejection && input.action !== "context") work.recent.push({ at, text: `Applied ${input.action}: ${input.text.slice(0, 2000)}` });
      receipts.push({ operation: "patchStatus" as const, resource: fact, patch: { handle: { ...fact.status.handle, [resource.metadata.uid]: {
        ...receipt, appliedAt: at, ...(complete ? { startedAt: at, completedAt: at,
        result: { summary: rejection ?? `Applied ${input.action} request`, disposition: rejection ? "rejected" as const : "completed" as const } } : {}) } } } });
    }
    const { title, instruction, recent, status, nextAt, question } = work;
    try {
      await context.resources.commit([
        { operation: "replace", resource, spec: { ...resource.spec, revision: resource.spec.revision + 1, title, instruction, ...(work.kind === "routine" ? { trigger: work.trigger! } : {}) },
          status: { ...resource.status, recent, status, nextAt, question } },
        ...receipts,
      ]);
      const updated = await context.resources.get<WorkSpec, WorkStatus>(resourceRef(resource));
      context.logger.info("Work requests applied", { attributes: { workId: work.id, count: unapplied.length, status } });
      return updated;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("resource version conflict")) throw error;
    }
  }
  throw new Error(`Work ${original.metadata.name} changed continuously while consuming input`);
}

export function workCompletionWatch(type: import("@compforge/aide-plugin").ResourceType): import("@compforge/aide-plugin").Watch {
  return { resourceType: type, handler: { create: async () => [], delete: async () => [], update: async ({ oldObject, newObject }) =>
    (oldObject as WorkResource).status.status === "running" && (newObject as WorkResource).status.status !== "running"
      ? [{ name: newObject.metadata.name, namespace: newObject.metadata.namespace }] : [] } };
}
