import { z } from "zod";
import type { ResourceClient, ResourceCommit } from "@compforge/aide-plugin";
import { SUMMARY_CHARS, RECENT_CHARS } from "../context.ts";
import { inputRef, resourceRef, pendingInputs } from "../input/state.ts";
import type { InputSpec, InputStatus } from "../input/model.ts";
import type { TaskResource, TaskSpec, TaskStatus } from "./model.ts";
export const TaskReportSchema = z.object({ inputIds: z.array(z.string().min(1)).max(99),
  summary: z.string().min(1).max(SUMMARY_CHARS), recent: z.string().min(1).max(RECENT_CHARS),
  action: z.enum(["done", "wait", "ask"]), question: z.string().nullable().optional(), nextAt: z.string().nullable().optional(),
}).strict();
/**
 * @spec Work progress and exact input acknowledgements commit together; an end_turn never acknowledges business work.
 * @link docs/harness/task.md
 * @case tests/task-agent.test.ts
 */
export async function reportTask(resources: ResourceClient, owner: Readonly<TaskResource>, executionId: string, raw: unknown) {
  const args = TaskReportSchema.parse(raw);
  if (new Set(args.inputIds).size !== args.inputIds.length) throw new Error("Duplicate input IDs in Task report");
  if (args.action === "ask" && !args.question?.trim()) throw new Error("ask requires question");
  if (args.action === "wait" && (!args.nextAt || !Number.isFinite(Date.parse(args.nextAt)) || Date.parse(args.nextAt) <= Date.now())) throw new Error("wait requires future nextAt");
  for (let attempt = 0; ; attempt++) {
    const task = await resources.get<TaskSpec, TaskStatus>(resourceRef(owner));
    if (!task || task.metadata.deletionTimestamp || task.status.execution?.id !== executionId) throw new Error("Task execution is no longer active");
    const at = new Date().toISOString();
    const writes: ResourceCommit[] = [];
    for (const id of args.inputIds) {
      const input = await resources.get<InputSpec, InputStatus>(inputRef(id));
      const receipt = input?.status.handle?.[task.metadata.uid];
      if (!input || !receipt) throw new Error(`Input is not assigned to Task: ${id}`);
      if (receipt.completedAt) continue;
      if (!receipt.executionId || (receipt.executionId !== executionId && !receipt.lastError)) throw new Error(`Input is not admitted: ${id}`);
      writes.push({ operation: "patchStatus", resource: input, patch: { handle: { ...input.status.handle, [task.metadata.uid]: {
        ...receipt, completedAt: at, result: { summary: args.recent, disposition: "completed" },
      } } } });
    }
    const remaining = (await pendingInputs(resources, resourceRef(task))).some(input => !args.inputIds.includes(input.metadata.name));
    const status = task.status.status === "paused" ? "paused" : args.action === "ask" ? "waiting" : args.action === "wait" ? "scheduled" : remaining ? "ready" : "done";
    writes.push({ operation: "patchStatus", resource: task, patch: { status, summary: args.summary,
      recent: [...task.status.recent, { at, text: args.recent }], question: args.action === "ask" ? args.question : null,
      nextAt: status === "scheduled" ? args.nextAt : null, lastExecutionId: executionId } });
    try { await resources.commit(writes); return { inputIds: args.inputIds, status }; }
    catch (error) { if (attempt >= 8 || !/version conflict/i.test(String(error))) throw error; }
  }
}
