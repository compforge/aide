import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkService } from "../../plugins/personal/work.ts";

const definition = {
  kind: Type.Union([Type.Literal("task"), Type.Literal("routine")]),
  title: Type.String({ minLength: 1 }), instruction: Type.String({ minLength: 1 }),
  trigger: Type.Union([Type.Null(), Type.Object({
    cron: Type.Union([Type.String(), Type.Null()]), timezone: Type.String(),
    event: Type.Union([Type.String(), Type.Null()]),
  }, { additionalProperties: false })]),
};
const id = Type.String({ minLength: 1 });
const revision = Type.Integer({ minimum: 1 });
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
const tool = <T extends TSchema>(definition: ToolDefinition<T>): ToolDefinition<T> => definition;

/** @spec Tool results reflect persisted Work state; creating work does not imply execution completed. */
export function workTools(work: WorkService): ToolDefinition[] {
  return [
    tool({ name: "list_work", label: "List work",
      description: "List this topic's tasks and routines. Check for related work before creating a new item.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_id, _args, signal) { signal?.throwIfAborted(); return result(work.list()); },
    }),
    tool({ name: "read_work", label: "Read work",
      description: "Read a task or routine, including revision, status, history and pending question. Reading never resumes execution.",
      parameters: Type.Object({ id }, { additionalProperties: false }),
      async execute(_id, args, signal) { signal?.throwIfAborted(); return result(work.read(args.id)); },
    }),
    tool({ name: "create_input", label: "Record independent decision",
      description: "Record a new independent Chief decision within existing entrusted authority. For a received Input use its existing ID instead. Returns inputId for create_work.",
      parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 32000 }) }, { additionalProperties: false }),
      async execute(callId, { text }, signal) { signal?.throwIfAborted(); return result(await work.createInput(text, callId)); },
    }),
    tool({ name: "create_work", label: "Create work",
      description: "Entrust a finite goal (task) or ongoing responsibility (routine) to Aide. Ordinary questions and immediate CLI queries do not need work items. Task trigger must be null; routine needs cron or event.",
      parameters: Type.Object({ ...definition, inputId: Type.Optional(id) }, { additionalProperties: false }),
      async execute(callId, { inputId, ...args }, signal) {
        signal?.throwIfAborted();
        if (args.kind === "task" && !inputId) throw new Error("Task creation requires inputId; use the received Input or create an independent Chief request first");
        return result(await work.create(args, inputId, callId));
      },
    }),
    tool({ name: "request_work", label: "Request work", description: "Create a new independent Chief request for existing Work. For handoff of a received Input use assess_input instead. This creates a new Input with its own handling receipt; it does not replay a completed request. Read Work before resuming uncertain effects.",
      parameters: Type.Object({ workId: id, text: Type.String({ minLength: 1 }),
        action: Type.Optional(Type.Union([Type.Literal("context"), Type.Literal("update"), Type.Literal("answer"), Type.Literal("resume"), Type.Literal("pause")])),
        changes: Type.Optional(Type.Partial(Type.Object({ title: definition.title, instruction: definition.instruction, trigger: definition.trigger }, { additionalProperties: false }))),
      }, { additionalProperties: false }),
      async execute(callId, { workId, ...args }, signal) { signal?.throwIfAborted(); return result(await work.requestInput(workId, args, callId)); },
    }),
    tool({ name: "delete_work", label: "Delete work",
      description: "Delete explicitly unwanted work using its latest revision. Keeps topic messages; does not undo external actions or cancel an already running command.",
      parameters: Type.Object({ id, revision }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        signal?.throwIfAborted(); await work.delete(args.id, args.revision); return result({ id: args.id, deleted: true });
      },
    }),
  ];
}
