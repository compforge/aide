import { summaryText, summaryReference } from "../note/summary.ts";
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
import { createRoutineAgent } from "../../../agents/routine/agent.ts";
import { reportWork } from "../work-report.ts";
import { ROUTINE_TYPE, type RoutineSpec, type RoutineStatus } from "./model.ts";
import { inputPrinter } from "../input/printer.ts";
import { say } from "../output/action.ts";
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
const tool = <T extends TSchema>(definition: ToolDefinition<T>): ToolDefinition<T> => definition;
/** Host binds scope; the model never supplies Routine or Topic identity. */
export function routineSession(scope: ExecutionScope, config: PiConfig, store: Store, plugins: Manager, log: Logger, persons?: Persons, channels: readonly ContactChannel[] = []): PiSessionFactory {
  const ref = scope.resourceRef;
  if (scope.pluginInstanceId !== "personal" || ref?.kind !== ROUTINE_TYPE.kind || ref.apiVersion !== ROUTINE_TYPE.apiVersion || !ref.uid) throw new Error("Routine requires its owning resource scope");
  return async options => {
    const current = () => {
      const routine = store.resources.get<RoutineSpec, RoutineStatus>(ROUTINE_TYPE, ref.name, ref.namespace);
      if (routine.metadata.uid !== ref.uid || routine.metadata.deletionTimestamp || !routine.status.execution) throw new Error("Routine execution is no longer active");
      plugins.executionVerbs(routine.status.execution.id, { topicId: store.topicId(routine.status.topic), routineId: routine.metadata.name });
      return routine;
    };
    const verbs = () => { const routine = current(); return plugins.executionVerbs(routine.status.execution!.id, { topicId: store.topicId(routine.status.topic), routineId: routine.metadata.name }); };
    const tools: ToolDefinition[] = [
      ...workContextTools("routine", plugins.resourceClient("personal"), current, log),
      ...(persons ? [contactsTool(persons, channels, current)] : []),
      tool({ name: "list_work", label: "List related work", description: "Page through this Topic's Task and Routine summaries; does not delegate or resume work.",
        parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
        async execute(_id, { offset = 0 }) { return result(contextPage(relatedWork(store, store.topicId(current().status.topic)), offset)); } }),
      tool({ name: "read_routine", label: "Read routine", description: "Read this Routine's objective, state, latest handling report, long-lived summary and recent Notes.", parameters: Type.Object({}),
        async execute() { const r = current(); return result({ ...r, summaryText: summaryText(store.resources, r), summaryNote: summaryReference(store.resources, r), version: contentVersion(r), recent: notes(store.resources, r.metadata.uid, "subject") }); } }),
      tool({ name: "read_topic", label: "Read topic", description: "Read the owning Topic as context, not additional authority.", parameters: Type.Object({}),
        async execute() { const c = store.topics.resource(store.topicId(current().status.topic)); return result(c ? { ...c.spec, summary: summaryText(store.resources, c), summaryUid: summaryReference(store.resources, c)?.uid, summaryNote: summaryReference(store.resources, c), recent: notes(store.resources, c.metadata.uid, "subject") } : null); } }),
      tool({ name: "read_input", label: "Read input", description: "List pending assigned inputs, or page through one assigned input. Failed attempts need effect inspection.",
        parameters: Type.Object({ inputId: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
        async execute(_id, { inputId, offset = 0 }) {
          const routine = current(), storeInputs = store.topics.inputStore;
          if (!inputId) { const all = storeInputs.query("handlePending", routine.metadata.uid); return result({ inputs: all.slice(offset, offset + 20).map(i => ({ inputId: i.metadata.name, handling: i.status.handle![routine.metadata.uid] })), nextOffset: offset + 20 < all.length ? offset + 20 : null }); }
          const input = storeInputs.get(inputId);
          if (!input?.status.handle?.[routine.metadata.uid]) throw new Error("Input is not assigned to this Routine");
          const text = inputPrinter.describe(input);
          return result({ inputId, handling: input.status.handle[routine.metadata.uid], text: text.slice(offset, offset + 8000), nextOffset: offset + 8000 < text.length ? offset + 8000 : null });
        } }),
      sayTool((id, input) => say(verbs(), { ...input, idempotencyKey: id })),
      tool({ name: "report_routine", label: "Report routine", description: "Atomically update Routine progress and acknowledge only inputs actually handled. report is a brief account of what was actually handled, preserving actors, authorization and confirmation state. This never updates long-lived summary or recent Notes. Use the independent summary and Note tools only when needed. Use say separately for user-visible communication.",
        parameters: Type.Object({ observedGeneration: Type.Optional(Type.Integer({ minimum: 1, description: "metadata.generation from the current resource. Read and verify the updated goal if it changed during execution." })), inputIds: Type.Array(Type.String()), report: Type.String({ minLength: 1, maxLength: 16000, description: "Brief result and evidence for this handling attempt, not long-lived understanding." }),
          action: Type.Union([Type.Literal("done"), Type.Literal("wait"), Type.Literal("ask")]), question: Type.Optional(Type.String()), nextAt: Type.Optional(Type.String()) }),
        async execute(_id, args) {
          const routine = current();
          const report = await reportWork(plugins.resourceClient("personal"), routine, routine.status.execution!.id, args, _id);
          log.info({ routineId: routine.metadata.name, routineUid: routine.metadata.uid, executionId: routine.status.execution!.id,
            inputIds: report.inputIds, status: report.status }, "Routine progress reported");
          return result(report);
        } }),
    ];
    return createRoutineAgent({ ...options, config, scope: `routine:${ref.uid}`, tools, background: identityBackground(persons, () => new Background(store, current())) });
  };
}
