import type { PluginContext } from "@compforge/aide-plugin";
import { nextOccurrence, validateTrigger } from "./model.ts";
import { toWork, type WorkResource, type WorkSpec, type WorkStatus } from "./resources.ts";

/**
 * @spec Only Work Reconcile applies inbox requests. Observations never resume paused, completed or uncertain work.
 * @spec Inbox consumption and the resulting state commit together; inputs arriving during execution remain pending.
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
    const pending = work.inputs.filter((input) => !work.consumedInputIds.includes(input.id));
    if (!pending.length) return resource;
    for (const input of pending) {
      work.history.push({ at: input.at, role: input.origin === "channel" ? "user" : "event",
        text: `[${input.origin}; input=${input.inputId ?? input.id}; request=${input.action}] ${input.text}${input.note ? `\nChief: ${input.note}` : ""}` });
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
          if (["ready", "waiting", "scheduled"].includes(work.status)) {
            const scheduled = input.action === "update" && work.kind === "routine";
            work.status = scheduled ? "scheduled" : "ready";
            work.nextAt = scheduled ? nextOccurrence(work.trigger, new Date()) : null;
            work.question = null;
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        work.history.push({ at: new Date().toISOString(), role: "aide", text: `Input ${input.id} rejected: ${reason}` });
        context.logger.warn("Work input rejected", { attributes: { workId: work.id, inputId: input.id, reason } });
      }
      work.consumedInputIds.push(input.id);
    }
    const { title, instruction, history, status, nextAt, question, consumedInputIds } = work;
    try {
      const updated = await context.resources.replace(resource,
        { ...resource.spec, title, instruction, ...(work.kind === "routine" ? { trigger: work.trigger! } : {}) },
        { ...resource.status, history, status, nextAt, question, consumedInputIds });
      context.logger.info("Work inputs consumed", { attributes: { workId: work.id, count: pending.length, status } });
      return updated;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("resource version conflict")) throw error;
    }
  }
  throw new Error(`Work ${original.metadata.name} changed continuously while consuming input`);
}
