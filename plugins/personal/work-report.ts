import { agentCall } from "./observation/reference.ts";
import { z } from "zod";
import type { Resource, ResourceClient, ResourceCommit } from "@compforge/aide-plugin";
import { SUMMARY_CHARS, RECENT_CHARS } from "./context.ts";
import { inputRef, resourceRef, pendingInputs } from "./input/state.ts";
import type { InputSpec, InputStatus } from "./input/model.ts";
import type { WorkSpec } from "./resources.ts";
import type { WorkAgentStatus } from "./work-status.ts";
import { nextOccurrence } from "./model.ts";
export const WorkReportSchema = z.object({ inputIds: z.array(z.string().min(1)).max(99),
  summary: z.string().min(1).max(SUMMARY_CHARS), recent: z.string().min(1).max(RECENT_CHARS),
  action: z.enum(["done", "wait", "ask"]), question: z.string().nullable().optional(), nextAt: z.string().nullable().optional(),
}).strict();
/**
 * @spec Work progress and exact input acknowledgements commit together; an end_turn never acknowledges business work.
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
    const at = new Date().toISOString();
    const writes: ResourceCommit[] = [];
    for (const id of args.inputIds) {
      const input = await resources.get<InputSpec, InputStatus>(inputRef(id));
      const receipt = input?.status.handle?.[work.metadata.uid];
      if (!input || !receipt) throw new Error(`Input is not assigned to Work: ${id}`);
      if (receipt.completedAt) continue;
      if (!receipt.executionId || (receipt.executionId !== executionId && !receipt.lastError)) throw new Error(`Input is not admitted: ${id}`);
      writes.push({ operation: "patchStatus", resource: input, patch: { handle: { ...input.status.handle, [work.metadata.uid]: {
        ...receipt, ...(toolCallId ? { completedBy: agentCall(work.status, toolCallId) } : {}), completedAt: at, result: { summary: args.recent, disposition: "completed" },
      } } } });
    }
    const remaining = (await pendingInputs(resources, resourceRef(work))).some(input => !args.inputIds.includes(input.metadata.name));
    const recurring = work.kind === "Routine" && "trigger" in work.spec;
    const status = work.status.status === "paused" ? "paused" : args.action === "ask" ? "waiting" : args.action === "wait" ? "scheduled" : remaining ? "ready" : recurring ? "scheduled" : "done";
    writes.push({ operation: "patchStatus", resource: work, patch: { status, summary: args.summary,
      recent: [...work.status.recent, { at, text: args.recent }], question: args.action === "ask" ? args.question : null,
      nextAt: status === "scheduled" ? (args.action === "wait" ? args.nextAt : recurring ? nextOccurrence(work.spec.trigger, new Date()) : null) : null, lastExecutionId: executionId } });
    try { await resources.commit(writes); return { inputIds: args.inputIds, status }; }
    catch (error) { if (attempt >= 8 || !/version conflict/i.test(String(error))) throw error; }
  }
}
