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
/** Host binds scope; the model never supplies Routine or Conversation identity. */
export function routineSession(scope: ExecutionScope, config: PiConfig, store: Store, plugins: Manager, log: Logger): PiSessionFactory {
  const ref = scope.resourceRef;
  if (scope.pluginInstanceId !== "personal" || ref?.kind !== ROUTINE_TYPE.kind || ref.apiVersion !== ROUTINE_TYPE.apiVersion || !ref.uid) throw new Error("Routine requires its owning resource scope");
  return async options => {
    const current = () => {
      const routine = store.resources.get<RoutineSpec, RoutineStatus>(ROUTINE_TYPE, ref.name, ref.namespace);
      if (routine.metadata.uid !== ref.uid || routine.metadata.deletionTimestamp || !routine.status.execution) throw new Error("Routine execution is no longer active");
      plugins.executionVerbs(routine.status.execution.id, { conversationId: routine.spec.conversationId, routineId: routine.metadata.name });
      return routine;
    };
    const verbs = () => { const routine = current(); return plugins.executionVerbs(routine.status.execution!.id, { conversationId: routine.spec.conversationId, routineId: routine.metadata.name }); };
    const tools: ToolDefinition[] = [
      tool({ name: "read_routine", label: "Read routine", description: "Read this Routine's objective, state and cumulative understanding.", parameters: Type.Object({}),
        async execute() { return result(current()); } }),
      tool({ name: "read_conv", label: "Read conversation", description: "Read the owning Conversation as context, not additional authority.", parameters: Type.Object({}),
        async execute() { const c = store.conversations.resource(current().spec.conversationId); return result(c ? { ...c.spec, summary: c.status.summary, recent: c.status.recent, outputTargets: store.conversations.outputTargets(c.spec.id) } : null); } }),
      tool({ name: "read_input", label: "Read input", description: "List pending assigned inputs, or page through one assigned input. Failed attempts need effect inspection.",
        parameters: Type.Object({ inputId: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
        async execute(_id, { inputId, offset = 0 }) {
          const routine = current(), storeInputs = store.conversations.inputStore;
          if (!inputId) { const all = storeInputs.query("handlePending", routine.metadata.uid); return result({ inputs: all.slice(offset, offset + 20).map(i => ({ inputId: i.metadata.name, handling: i.status.handle![routine.metadata.uid] })), nextOffset: offset + 20 < all.length ? offset + 20 : null }); }
          const input = storeInputs.get(inputId);
          if (!input?.status.handle?.[routine.metadata.uid]) throw new Error("Input is not assigned to this Routine");
          const text = inputPrinter.describe(input);
          return result({ inputId, handling: input.status.handle[routine.metadata.uid], text: text.slice(offset, offset + 8000), nextOffset: offset + 8000 < text.length ? offset + 8000 : null });
        } }),
      tool({ name: "say", label: "Say", description: "Create an Output through this Routine's Conversation. Success means persisted; only status.phase=delivered confirms delivery. Delivery and recovery are handled by the Host.",
        parameters: Type.Object({ text: Type.String({ minLength: 1 }), inputIds: Type.Optional(Type.Array(Type.String())) }),
        async execute(id, args) {
          const routine = current();
          for (const inputId of args.inputIds ?? []) if (!store.conversations.inputStore.get(inputId)?.status.handle?.[routine.metadata.uid]) throw new Error("Output input is not assigned to Routine");
          return result(await say(verbs(), { ...args, idempotencyKey: id }));
        } }),
      tool({ name: "report_routine", label: "Report routine", description: "Atomically update Routine progress and acknowledge only inputs actually handled. Use say separately for user-visible communication.",
        parameters: Type.Object({ inputIds: Type.Array(Type.String()), summary: Type.String({ minLength: 1, maxLength: 16000 }), recent: Type.String({ minLength: 1, maxLength: 16000 }),
          action: Type.Union([Type.Literal("done"), Type.Literal("wait"), Type.Literal("ask")]), question: Type.Optional(Type.String()), nextAt: Type.Optional(Type.String()) }),
        async execute(_id, args) {
          const routine = current();
          const report = await reportWork(plugins.resourceClient("personal"), routine, routine.status.execution!.id, args);
          log.info({ routineId: routine.metadata.name, routineUid: routine.metadata.uid, executionId: routine.status.execution!.id,
            inputIds: report.inputIds, status: report.status }, "Routine progress reported");
          return result(report);
        } }),
    ];
    return createRoutineAgent({ ...options, config, scope: `routine:${ref.uid}`, tools });
  };
}
