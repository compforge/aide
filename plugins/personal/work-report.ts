import { workPhase } from "./status.ts";
import { commitStatus } from "./status.ts";
import { agentCall } from "./observation/reference.ts";
import { z } from "zod";
import type { Resource, ResourceClient, ResourceCommit } from "@compforge/aide-plugin";
import { RECENT_CHARS } from "./context.ts";
import { inputRef, resourceRef, pendingInputs } from "./input/state.ts";
import type { InputSpec, InputStatus } from "./input/model.ts";
import type { WorkSpec } from "./resources.ts";
import type { WorkAgentStatus } from "./work-status.ts";
import { nextOccurrence } from "./model.ts";
export const WorkReportSchema = z.object({ observedGeneration: z.number().int().positive().optional(), inputIds: z.array(z.string().min(1)).max(99),
  report: z.string().trim().min(1).max(RECENT_CHARS),
  action: z.enum(["done", "wait", "ask"]), question: z.string().nullable().optional(), nextAt: z.string().nullable().optional(),
}).strict();
/**
 * @spec Work progress, latest report and exact input acknowledgements commit together; an end_turn never acknowledges business work.
 * @spec Reports never rewrite long-lived summary or create recent Notes.
 * @link docs/personal/input.md#研判与办理
 * @case tests/work-context.test.ts
 */
export async function reportWork(resources: ResourceClient, owner: Readonly<Resource<WorkSpec, WorkAgentStatus>>, executionId: string, raw: unknown, toolCallId?: string) {
  const args = WorkReportSchema.parse(raw);
  if (new Set(args.inputIds).size !== args.inputIds.length) throw new Error("Duplicate input IDs in Work report");
  if (args.action === "ask" && !args.question?.trim()) throw new Error("ask requires question");
  if (args.action === "wait" && (!args.nextAt || !Number.isFinite(Date.parse(args.nextAt)) || Date.parse(args.nextAt) <= Date.now())) throw new Error("wait requires future nextAt");
  for (let attempt = 0; ; attempt++) {
    const work = await resources.get<WorkSpec, WorkAgentStatus>(resourceRef(owner));
    if (!work || work.metadata.deletionTimestamp || work.status.execution?.id !== executionId) throw new Error("Work execution is no longer active");
    const generation = args.observedGeneration ?? work.status.execution!.observedGeneration ?? work.metadata.generation;
    if (generation !== work.metadata.generation && (!work.spec.paused || args.observedGeneration !== undefined))
      throw new Error("Work spec changed; read the current resource and report its observedGeneration after verifying the updated goal");
    const at = new Date().toISOString();
    const writes: ResourceCommit[] = [];
    for (const id of args.inputIds) {
      const input = await resources.get<InputSpec, InputStatus>(inputRef(id));
      const receipt = input?.status.handle?.[work.metadata.uid];
      if (!input || !receipt) throw new Error(`Input is not assigned to Work: ${id}`);
      if (receipt.completedAt) continue;
      if (!receipt.executionId || (receipt.executionId !== executionId && !receipt.lastError)) throw new Error(`Input is not admitted: ${id}`);
      writes.push({ operation: "patchStatus", resource: input, patch: { handle: { ...input.status.handle, [work.metadata.uid]: {
        ...receipt, ...(toolCallId ? { completedBy: agentCall(work.status, toolCallId) } : {}), completedAt: at, result: { summary: args.report, disposition: "completed" },
      } } } });
    }
    const remaining = (await pendingInputs(resources, resourceRef(work))).some(input => !args.inputIds.includes(input.metadata.name));
    const recurring = work.kind === "Routine" && "trigger" in work.spec;
    const outcome = { at, text: args.report, executionId, observedGeneration: generation };
    const update: Partial<WorkAgentStatus> = { lastReport: { at, text: args.report }, lastExecutionId: executionId,
      waiting: args.action === "ask" ? { question: args.question! } : args.action === "wait" ? { until: args.nextAt! } : null,
      recovery: null,
      ...(recurring ? { lastOccurrence: args.action === "done" && !remaining ? outcome : work.status.lastOccurrence ?? null,
        nextTriggerAt: args.action === "done" && !remaining ? nextOccurrence(work.spec.trigger, new Date()) : null }
        : { completion: args.action === "done" && !remaining ? outcome : null }),
    };
    const status = workPhase({ ...work, status: { ...work.status, ...update } });
    writes.push({ operation: "patchStatus", resource: work, patch: update });
    try { await commitStatus(resources, writes); return { inputIds: args.inputIds, status }; }
    catch (error) { if (attempt >= 8 || !/version conflict/i.test(String(error))) throw error; }
  }
}
