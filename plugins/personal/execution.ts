import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PluginContext, ReconcileContext } from "@compforge/aide-plugin";
import { OutcomeSchema, executionPrompt } from "./prompts.ts";
import { type Work, type WorkStatus } from "./model.ts";
import { toWork, type WorkResource, type WorkSpec } from "./resources.ts";

/** @spec A completed execution with an invalid result is not an interrupted execution and must not be replayed automatically. */
class InvalidResultError extends Error {
  constructor(message: string, readonly laneId: string, readonly turnId: string) {
    super(message); this.name = "InvalidResultError";
  }
}

/** Personal decisions consume a completed Harness Turn; the runtime owns execution and cancellation. */
async function infer<T>(context: ReconcileContext, title: string, prompt: string, schema: z.ZodType<T>, timeoutMs: number,
  lane: { laneId: string; newLane?: boolean }): Promise<{ value: T; laneId: string; turnId: string }> {
  const result = await context.verbs.harness({ title, ...lane, timeoutMs,
    prompt: `${prompt}\nYour final answer must be only JSON matching this schema, without Markdown. Keep any progress commentary in separate messages, outside the final answer:\n${JSON.stringify(z.toJSONSchema(schema))}`,
  });
  if (result.state !== "success") throw new Error(`Harness ${result.state}${result.state === "failure" ? `: ${result.error}` : ""}`);
  if (result.value.outcome !== "completed") throw new Error("Harness invocation declined");
  const turn = result.value.turn;
  if (turn.stopReason !== "end_turn") throw new Error(`Harness did not complete: ${turn.stopReason}`);
  const { laneId } = result.value;
  const text = turn.finalText?.trim();
  if (!text) throw new InvalidResultError("Harness completed without a designated final answer", laneId, turn.turnId);
  let data: unknown;
  try { data = JSON.parse(text); }
  catch { throw new InvalidResultError("Final answer is not valid JSON", laneId, turn.turnId); }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new InvalidResultError("Final answer does not match the result schema", laneId, turn.turnId);
  return { value: parsed.data, laneId, turnId: turn.turnId };
}

function reference(resource: WorkResource) {
  return { apiVersion: resource.apiVersion, kind: resource.kind, name: resource.metadata.name, namespace: resource.metadata.namespace, uid: resource.metadata.uid };
}

/**
 * @spec Rebase the observation after IPC waits; retry persistence conflicts without repeating Harness execution.
 * @link docs/plugin/personal.md
 */
async function record(context: PluginContext, original: WorkResource, update: (work: Work) => string | null,
  laneId?: string): Promise<Work | undefined> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const current = await context.resources.get<WorkSpec, WorkStatus>(reference(original));
    if (!current || current.metadata.deletionTimestamp) return;
    const work = toWork(current);
    const notification = update(work);
    const { id: _id, conversationId, kind: _kind, title: _title, instruction: _instruction,
      trigger: _trigger, revision: _revision, inputs: _inputs, ...observation } = work;
    const messages = [...current.status.messages];
    if (notification) messages.push({ id: randomUUID(), conversationId, text: notification, workId: work.id,
      at: new Date(Math.max(Date.now(), ...messages.map((item) => Date.parse(item.at) + 1))).toISOString(), role: "aide" });
    try {
      await context.resources.patchStatus(current, { ...observation, messages, ...(laneId ? { laneId } : {}) });
      return work;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("resource version conflict")) throw error;
    }
  }
  throw new Error(`Work ${original.metadata.name} changed continuously while recording execution`);
}

async function uncertain(context: PluginContext, resource: WorkResource): Promise<void> {
  await record(context, resource, (work) => {
    work.status = "uncertain"; work.nextAt = null;
    work.history.push({ at: new Date().toISOString(), role: "aide", text: "Execution interrupted or failed; verify external effects before retrying." });
    return `「${work.title}」执行中断或失败，外部结果尚不确定。请核对后告诉我是否继续。`;
  });
}

interface CompletedWork {
  work: Work;
  result: z.infer<typeof OutcomeSchema>;
  laneId: string;
}

/** @spec Execution admission, result validation and failure recording are shared; each controller owns successful completion. */
export async function executeWork(context: PluginContext, execution: ReconcileContext, resource: WorkResource): Promise<CompletedWork | undefined> {
  execution = execution.withContext({ conversationId: resource.spec.conversationId });
  const work = toWork(resource);
  if (work.status === "running") { await uncertain(context, resource); return; }
  if (work.status !== "ready" && !(work.status === "scheduled" && work.nextAt && Date.parse(work.nextAt) <= Date.now())) return;
  // Commit before the external operation; a crashed continuation must never replay it.
  await context.resources.patchStatus(resource, { status: "running" });
  context.logger.info("Execution started", { attributes: { workId: work.id, resourceKind: resource.kind, revision: work.revision } });
  let result: z.infer<typeof OutcomeSchema>;
  let laneId: string;
  try {
    const completed = await infer(execution, work.title, executionPrompt(work), OutcomeSchema, 15 * 60_000,
      resource.status.laneId ? { laneId: resource.status.laneId } : { laneId: "main", newLane: true });
    result = completed.value; laneId = completed.laneId;
    if (result.action === "ask" && !result.question?.trim()) throw new InvalidResultError("ask requires a question", laneId, completed.turnId);
    if (result.action === "wait" && (!result.nextAt || !Number.isFinite(Date.parse(result.nextAt)) || Date.parse(result.nextAt) <= Date.now())) {
      throw new InvalidResultError("wait requires a future nextAt", laneId, completed.turnId);
    }
  } catch (error) {
    if (error instanceof InvalidResultError) {
      context.logger.error("Execution completed with an invalid result", {
        error, attributes: { workId: work.id, laneId: error.laneId, turnId: error.turnId },
      });
      await record(context, resource, (current) => {
        current.status = "invalid_result"; current.nextAt = null; current.question = null;
        current.history.push({ at: new Date().toISOString(), role: "aide",
          text: `Execution completed but result validation failed: ${error.message}. Turn: ${error.turnId}. Verify the recorded output before explicitly continuing.` });
        return `「${current.title}」执行已结束，但最终结果解析失败，尚未确认事项完成。请核对执行记录后，再决定是否继续。`;
      }, error.laneId);
      return;
    }
    context.logger.error("Execution outcome uncertain", { error, attributes: { workId: work.id } });
    await uncertain(context, resource);
    return;
  }
  return { work, result, laneId };
}

export async function recordOutcome(context: PluginContext, resource: WorkResource, completed: CompletedWork,
  complete: (work: Work) => void): Promise<void> {
  const { work, result, laneId } = completed;
  const recorded = await record(context, resource, (current) => {
    current.history.push({ at: new Date().toISOString(), role: "aide", text: result.summary });
    if (current.revision !== work.revision) {
      // The next Reconcile consumes new input before deciding whether another execution is needed.
      if (current.status !== "paused") { current.status = "ready"; current.nextAt = null; }
    } else if (result.action === "ask") {
      current.status = "waiting"; current.question = result.question; current.nextAt = null;
    } else if (result.action === "wait") {
      current.status = "scheduled"; current.nextAt = result.nextAt;
    } else {
      complete(current);
    }
    return current.revision === work.revision && result.action === "ask" ? result.question : result.notification;
  }, laneId);
  context.logger.info("Execution recorded", { attributes: { workId: work.id, resourceKind: resource.kind, status: recorded?.status ?? "deleted" } });
}

/** @spec Dynamic wait deadlines survive reconciliation even when no execution is due yet. */
export async function scheduledReconcile(context: PluginContext, resource: WorkResource) {
  const latest = await context.resources.get<WorkSpec, WorkStatus>(reference(resource));
  if (latest && !latest.metadata.deletionTimestamp && latest.status.status === "scheduled" && latest.status.nextAt) {
    return { requeueAfterMs: Math.max(1, Date.parse(latest.status.nextAt) - Date.now()) };
  }
}
