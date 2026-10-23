import { INPUT_TYPE, type InputSpec, type InputStatus } from "./input/model.ts";
import { inputPrinter } from "./input/printer.ts";
import type { Resource } from "@compforge/aide-plugin";
import { outputWrite } from "./output.ts";
import { CONVERSATION_TYPE, type ConversationSpec, type ConversationStatus } from "./conversation/model.ts";
import { digest } from "./chief-model.ts";
import { z } from "zod";
import type { PluginContext, ReconcileContext, ResourceCommit } from "@compforge/aide-plugin";
import { OutcomeSchema, executionPrompt } from "./prompts.ts";
import { type Work, type WorkStatus } from "./model.ts";
import { toWork, type WorkResource, type WorkSpec } from "./resources.ts";

/** @spec A completed execution with an invalid result is not an interrupted execution and must not be replayed automatically. */
class InvalidResultError extends Error {
  constructor(message: string, readonly invocationId: string) {
    super(message); this.name = "InvalidResultError";
  }
}

/** Personal decisions consume a completed Harness invocation; the runtime owns execution and cancellation. */
async function infer<T>(context: ReconcileContext, title: string, prompt: string, schema: z.ZodType<T>, timeoutMs: number): Promise<{ value: T; invocationId: string }> {
  const result = await context.verbs.harness({ title, timeoutMs, freshContext: true,
    prompt: `${prompt}\nYour final answer must be only JSON matching this schema, without Markdown. Keep any progress commentary in separate messages, outside the final answer:\n${JSON.stringify(z.toJSONSchema(schema))}`,
  });
  if (result.state !== "success") throw new Error(`Harness ${result.state}${result.state === "failure" ? `: ${result.error}` : ""}`);
  if (result.value.outcome !== "completed") throw new Error("Harness invocation declined");
  const execution = result.value.result;
  if (execution.stopReason !== "end_turn") throw new Error(`Harness did not complete: ${execution.stopReason}`);
  const text = execution.finalText?.trim();
  if (!text) throw new InvalidResultError("Harness completed without a designated final answer", result.value.invocationId);
  let data: unknown;
  try { data = JSON.parse(text); }
  catch { throw new InvalidResultError("Final answer is not valid JSON", result.value.invocationId); }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new InvalidResultError("Final answer does not match the result schema", result.value.invocationId);
  return { value: parsed.data, invocationId: result.value.invocationId };
}

function reference(resource: WorkResource) {
  return { apiVersion: resource.apiVersion, kind: resource.kind, name: resource.metadata.name, namespace: resource.metadata.namespace, uid: resource.metadata.uid };
}

/**
 * @spec Rebase the observation after IPC waits; retry persistence conflicts without repeating Harness execution.
 * @link docs/plugin/personal.md
 */
async function record(context: PluginContext, original: WorkResource, update: (work: Work) => string | null,
  receipts?: { id: string; inputs: Resource<InputSpec, InputStatus>[]; error?: string },
  ): Promise<Work | undefined> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const current = await context.resources.get<WorkSpec, WorkStatus>(reference(original));
    if (!current || current.metadata.deletionTimestamp) return;
    const work = toWork(current);
    const notification = update(work);
    const { id: _id, conversationId, kind: _kind, title: _title, instruction: _instruction,
      trigger: _trigger, revision: _revision, uid: _uid, ...observation } = work;
    const writes: ResourceCommit[] = [];
    if (receipts) {
      for (const original of receipts.inputs) {
        const input = await context.resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, ...original.metadata });
        const receipt = input?.status.handle?.[current.metadata.uid];
        if (!input || !receipt || receipt.executionId !== receipts.id || receipt.completedAt) throw new Error("Work input execution receipt changed");
        writes.push({ operation: "patchStatus", resource: input, patch: { handle: { ...input.status.handle, [current.metadata.uid]: {
          ...receipt, ...(receipts.error ? { lastError: receipts.error } : { completedAt: new Date().toISOString(), result: { summary: work.summary, disposition: "completed" } }) } } } });
      }
      const remaining = await context.resources.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: "handlePending", value: current.metadata.uid } });
      if (!receipts.error && remaining.some(input => !receipts.inputs.some(done => done.metadata.uid === input.metadata.uid)) && ["done", "scheduled"].includes(work.status)) {
        work.status = "ready"; work.nextAt = null;
        observation.status = work.status; observation.nextAt = null;
      }
    }
    if (notification) {
      const conversation = await context.resources.get<ConversationSpec, ConversationStatus>({ ...CONVERSATION_TYPE, namespace: "v1", name: digest(conversationId) });
      if (!conversation) throw new Error(`Work ${work.id} Output Conversation missing: ${conversationId}`);
      if (conversation.spec.address) {
        writes.push(outputWrite(conversation, { id: `work:${current.metadata.uid}:${current.metadata.resourceVersion}`, conversationId, text: notification, workId: work.id },
          { producer: { ...reference(current) } }));
      } else {
        work.recent.push({ at: new Date().toISOString(), text: `No communication address; retained result: ${notification}` });
        context.logger.info("Work result retained without Output: Conversation has no address", { attributes: { workId: work.id, conversationId } });
      }
    }
    try {
      await context.resources.commit([{ operation: "patchStatus", resource: current, patch: { ...observation } }, ...writes]);
      return work;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("resource version conflict")) throw error;
    }
  }
  throw new Error(`Work ${original.metadata.name} changed continuously while recording execution`);
}

async function uncertain(context: PluginContext, resource: WorkResource, receipts?: { id: string; inputs: Resource<InputSpec, InputStatus>[] }): Promise<void> {
  await record(context, resource, (work) => {
    work.status = "uncertain"; work.nextAt = null;
    work.recent.push({ at: new Date().toISOString(), text: "Execution interrupted or failed; verify external effects before retrying." });
    return `「${work.title}」执行中断或失败，外部结果尚不确定。请核对后告诉我是否继续。`;
  }, receipts ? { ...receipts, error: "Execution interrupted or failed; verify external effects before retrying" } : undefined);
}

interface CompletedWork {
  receipt: { id: string; inputs: Resource<InputSpec, InputStatus>[] };
  work: Work;
  result: z.infer<typeof OutcomeSchema>;
}

/** @spec Execution admission, result validation and failure recording are shared; each controller owns successful completion. */
export async function executeWork(context: PluginContext, execution: ReconcileContext, resource: WorkResource, admissionAttempt = 0): Promise<CompletedWork | undefined> {
  execution = execution.withContext({ conversationId: resource.spec.conversationId });
  const work = toWork(resource);
  if (work.status === "running") { await uncertain(context, resource); return; }
  if (work.status !== "ready" && !(work.status === "scheduled" && work.nextAt && Date.parse(work.nextAt) <= Date.now())) return;
  // Admission freezes membership on Input. No second resource queue; arrivals stay pending.
  const pending = await context.resources.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: "handlePending", value: resource.metadata.uid } });
  const inputs: Resource<InputSpec, InputStatus>[] = [];
  const materials: unknown[] = [];
  let remaining = 64000;
  for (const input of pending) {
    if (!input.status.handle![resource.metadata.uid]!.appliedAt) continue;
    const request = input.status.handle![resource.metadata.uid]!.request;
    const observation = input.spec.observation === undefined ? undefined : JSON.stringify(input.spec.observation);
    const material = { inputId: input.metadata.name, text: input.spec.text, origin: input.spec.origin, source: input.spec.source,
      sender: input.spec.sender, action: request.action, note: request.note,
      observation: observation?.slice(0, 8000), observationTruncated: !!observation && observation.length > 8000 };
    const size = JSON.stringify(material).length;
    if (size > 64000) throw new Error(`Input ${input.metadata.name} exceeds Work context budget; it remains pending`);
    if (size > remaining || inputs.length === 20) break;
    inputs.push(input); materials.push(material); remaining -= size;
  }
  const receipt = { id: execution.executionId, inputs };
  execution = execution.withContext({ conversationId: work.conversationId, inputIds: inputs.map(input => input.metadata.name) });
  try {
    await context.resources.commit([
      { operation: "patchStatus", resource, patch: { status: "running" } },
      ...inputs.map(input => {
        const { lastError: _error, ...handling } = input.status.handle![resource.metadata.uid]!;
        return { operation: "patchStatus" as const, resource: input, patch: { handle: { ...input.status.handle,
          [resource.metadata.uid]: { ...handling, executionId: receipt.id, startedAt: new Date().toISOString() } } } };
      }),
    ]);
  } catch (error) {
    // No Harness call has started: shared Input status can safely be re-read after another consumer writes it.
    if (admissionAttempt >= 8 || !/resource version conflict/.test(String(error))) throw error;
    const latest = await context.resources.get<WorkSpec, WorkStatus>(reference(resource));
    if (!latest || latest.metadata.deletionTimestamp) return;
    context.logger.info("Work admission conflicted; retrying before execution", { attributes: { workId: work.id, attempt: admissionAttempt + 1 } });
    return executeWork(context, execution, latest, admissionAttempt + 1);
  }
  context.logger.info("Execution started", { attributes: { workId: work.id, resourceKind: resource.kind, revision: work.revision, executionId: receipt.id, inputCount: inputs.length } });
  let result: z.infer<typeof OutcomeSchema>;
  try {
    const completed = await infer(execution, work.title, executionPrompt(work, materials), OutcomeSchema, 15 * 60_000);
    result = completed.value;
    if (result.action === "ask" && !result.question?.trim()) throw new InvalidResultError("ask requires a question", completed.invocationId);
    if (result.action === "wait" && (!result.nextAt || !Number.isFinite(Date.parse(result.nextAt)) || Date.parse(result.nextAt) <= Date.now())) {
      throw new InvalidResultError("wait requires a future nextAt", completed.invocationId);
    }
  } catch (error) {
    if (error instanceof InvalidResultError) {
      context.logger.error("Execution completed with an invalid result", {
        error, attributes: { workId: work.id, invocationId: error.invocationId },
      });
      await record(context, resource, (current) => {
        current.status = "invalid_result"; current.nextAt = null; current.question = null;
        current.recent.push({ at: new Date().toISOString(),
          text: `Execution completed but result validation failed: ${error.message}. Invocation: ${error.invocationId}. Verify the recorded output before explicitly continuing.` });
        return `「${current.title}」执行已结束，但最终结果解析失败，尚未确认事项完成。请核对执行记录后，再决定是否继续。`;
      }, { ...receipt, error: error.message });
      return;
    }
    context.logger.error("Execution outcome uncertain", { error, attributes: { workId: work.id } });
    await uncertain(context, resource, receipt);
    return;
  }
  return { work, result, receipt };
}

export async function recordOutcome(context: PluginContext, resource: WorkResource, completed: CompletedWork,
  complete: (work: Work) => void): Promise<void> {
  const { work, result, receipt } = completed;
  const recorded = await record(context, resource, (current) => {
    current.summary = result.summary;
    for (const input of receipt.inputs) current.recent.push({ at: new Date().toISOString(),
      text: `Handled input ${input.metadata.name}: ${inputPrinter.summarize(input)}${input.status.handle![resource.metadata.uid]!.request.note ? `; ${input.status.handle![resource.metadata.uid]!.request.note}` : ""}` });
    current.recent.push({ at: new Date().toISOString(), text: result.recent });
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
  }, receipt);
  context.logger.info("Execution recorded", { attributes: { workId: work.id, resourceKind: resource.kind, status: recorded?.status ?? "deleted" } });
}

/** @spec Dynamic wait deadlines survive reconciliation even when no execution is due yet. */
export async function scheduledReconcile(context: PluginContext, resource: WorkResource) {
  const latest = await context.resources.get<WorkSpec, WorkStatus>(reference(resource));
  if (latest && !latest.metadata.deletionTimestamp && latest.status.status === "scheduled" && latest.status.nextAt) {
    return { requeueAfterMs: Math.max(1, Date.parse(latest.status.nextAt) - Date.now()) };
  }
}
