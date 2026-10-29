import { contentVersion } from "../context-write.ts";
import { notes } from "../note/query.ts";
import { workContextTools } from "../work-context.ts";
import { sayTool, contactsTool, type ContactChannel } from "../output/tool.ts";
import { identityBackground } from "../../../agents/personal.ts";
import type { Persons } from "../person/service.ts";
import { contextPage, relatedWork } from "../background.ts";
import { Background } from "./background.ts";
import type { Logger } from "pino";
import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiConfig } from "../../../src/host/harness/pi/config.ts";
import type { PiSessionFactory } from "../../../src/host/harness/pi/adapter.ts";
import type { ExecutionScope } from "../../../src/protocol/verbs.ts";
import type { Manager } from "../../../src/host/plugin/manager.ts";
import type { Store } from "../store.ts";
import { createTaskAgent } from "../../../agents/task/agent.ts";
import { reportWork } from "../work-report.ts";
import { TASK_TYPE, type TaskSpec, type TaskStatus } from "./model.ts";
import { inputPrinter } from "../input/printer.ts";
import { say } from "../output/action.ts";
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
const tool = <T extends TSchema>(definition: ToolDefinition<T>): ToolDefinition<T> => definition;
/** Host binds scope; the model never supplies Task or Topic identity. */
export function taskSession(scope: ExecutionScope, config: PiConfig, store: Store, plugins: Manager, log: Logger, persons?: Persons, channels: readonly ContactChannel[] = []): PiSessionFactory {
  const ref = scope.resourceRef;
  if (scope.pluginInstanceId !== "personal" || ref?.kind !== TASK_TYPE.kind || ref.apiVersion !== TASK_TYPE.apiVersion || !ref.uid) throw new Error("Task requires its owning resource scope");
  return async options => {
    const current = () => {
      const task = store.resources.get<TaskSpec, TaskStatus>(TASK_TYPE, ref.name, ref.namespace);
      if (task.metadata.uid !== ref.uid || task.metadata.deletionTimestamp || !task.status.execution) throw new Error("Task execution is no longer active");
      plugins.executionVerbs(task.status.execution.id, { topicId: store.topicId(task.status.topic), taskId: task.metadata.name });
      return task;
    };
    const verbs = () => { const task = current(); return plugins.executionVerbs(task.status.execution!.id, { topicId: store.topicId(task.status.topic), taskId: task.metadata.name }); };
    const tools: ToolDefinition[] = [
      ...workContextTools("task", plugins.resourceClient("personal"), current, log),
      ...(persons ? [contactsTool(persons, channels, current)] : []),
      tool({ name: "list_work", label: "List related work", description: "Page through this Topic's Task and Routine summaries; does not delegate or resume work.",
        parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
        async execute(_id, { offset = 0 }) { return result(contextPage(relatedWork(store, store.topicId(current().status.topic)), offset)); } }),
      tool({ name: "read_task", label: "Read task", description: "Read this Task's objective, state, latest handling report, long-lived summary and recent Notes.", parameters: Type.Object({}),
        async execute() { const r = current(); return result({ ...r, version: contentVersion(r), recent: notes(store.resources, r.metadata.uid) }); } }),
      tool({ name: "read_topic", label: "Read topic", description: "Read the owning Topic as context, not additional authority.", parameters: Type.Object({}),
        async execute() { const c = store.topics.resource(store.topicId(current().status.topic)); return result(c ? { ...c.spec, summary: c.status.summary, recent: notes(store.resources, c.metadata.uid) } : null); } }),
      tool({ name: "read_input", label: "Read input", description: "List pending assigned inputs, or page through one assigned input. Failed attempts need effect inspection.",
        parameters: Type.Object({ inputId: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
        async execute(_id, { inputId, offset = 0 }) {
          const task = current(), storeInputs = store.topics.inputStore;
          if (!inputId) { const all = storeInputs.query("handlePending", task.metadata.uid); return result({ inputs: all.slice(offset, offset + 20).map(i => ({ inputId: i.metadata.name, handling: i.status.handle![task.metadata.uid] })), nextOffset: offset + 20 < all.length ? offset + 20 : null }); }
          const input = storeInputs.get(inputId);
          if (!input?.status.handle?.[task.metadata.uid]) throw new Error("Input is not assigned to this Task");
          const text = inputPrinter.describe(input);
          return result({ inputId, handling: input.status.handle[task.metadata.uid], text: text.slice(offset, offset + 8000), nextOffset: offset + 8000 < text.length ? offset + 8000 : null });
        } }),
      sayTool((id, input) => say(verbs(), { ...input, idempotencyKey: id })),
      tool({ name: "report_task", label: "Report task", description: "Atomically update Task progress and acknowledge only inputs actually handled. report is a brief account of what was actually handled, preserving actors, authorization and confirmation state. This never updates long-lived summary or recent Notes. Use the independent summary and Note tools only when needed. Use say separately for user-visible communication.",
        parameters: Type.Object({ observedGeneration: Type.Optional(Type.Integer({ minimum: 1, description: "metadata.generation from the current resource. Read and verify the updated goal if it changed during execution." })), inputIds: Type.Array(Type.String()), report: Type.String({ minLength: 1, maxLength: 16000, description: "Brief result and evidence for this handling attempt, not long-lived understanding." }),
          action: Type.Union([Type.Literal("done"), Type.Literal("wait"), Type.Literal("ask")]), question: Type.Optional(Type.String()), nextAt: Type.Optional(Type.String()) }),
        async execute(_id, args) {
          const task = current();
          const report = await reportWork(plugins.resourceClient("personal"), task, task.status.execution!.id, args, _id);
          log.info({ taskId: task.metadata.name, taskUid: task.metadata.uid, executionId: task.status.execution!.id,
            inputIds: report.inputIds, status: report.status }, "Task progress reported");
          return result(report);
        } }),
    ];
    return createTaskAgent({ ...options, config, scope: `task:${ref.uid}`, tools, background: identityBackground(persons, () => new Background(store, current())) });
  };
}
