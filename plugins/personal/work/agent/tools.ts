import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkService } from "../service.ts";

const definition = {
  title: Type.String({ minLength: 1 }), instruction: Type.String({ minLength: 1, description: "State the goal entrusted to Aide, its authorization basis and scope; distinguish background facts and unconfirmed proposals." }),
  trigger: Type.Union([Type.Null(), Type.Object({
    cron: Type.Union([Type.String(), Type.Null()]), timezone: Type.String(),
    event: Type.Union([Type.String(), Type.Null()]),
  }, { additionalProperties: false })]),
};
export const workKindField = Type.Union([Type.Literal("task"), Type.Literal("routine"), Type.Literal("ongoing")]);
const id = Type.String({ minLength: 1 });
const revision = Type.Integer({ minimum: 1 });
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
const tool = <T extends TSchema>(definition: ToolDefinition<T>): ToolDefinition<T> => definition;

/** @spec Tool results reflect persisted Work state; creating work does not imply execution completed. */
export function workTools(work: WorkService): ToolDefinition[] {
  return [
    tool({ name: "list_work", label: "List work",
      description: "Find tasks, routines and open ongoing matters in this Topic subtree. Check existing responsibilities before creating one. includeClosed also returns concluded Ongoing matters.",
      parameters: Type.Object({ kind: Type.Optional(workKindField), includeClosed: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      async execute(_id, args, signal) { signal?.throwIfAborted(); return result(work.listItems(args.kind, args.includeClosed)); },
    }),
    tool({ name: "read_work", label: "Read work",
      description: "Read a Task, Routine or Ongoing by id, including its current state and pending question. Reading never resumes execution.",
      parameters: Type.Object({ id }, { additionalProperties: false }),
      async execute(_id, args, signal) { signal?.throwIfAborted(); return result(await work.readItem(args.id)); },
    }),
    tool({ name: "create_input", label: "Record independent decision",
      description: "Record a new independent Chief decision within existing entrusted authority. For a received Input use its existing ID instead. Returns inputId for create_work or append_input.",
      parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 32000 }) }, { additionalProperties: false }),
      async execute(callId, { text }, signal) { signal?.throwIfAborted(); return result(await work.createInput(text, callId)); },
    }),
    tool({ name: "create_work", label: "Create work",
      description: "Declare a responsibility that outlasts this Input. Delegate a finite goal to a Task Agent or a recurring duty to a Routine Agent. For ongoing, Chief keeps the matter and follows it to a conclusion. Task and routine require instruction and trigger (null for task). A task requires inputId. Ongoing requires title, optionally progress, question and checkAt; it stays with Chief and defaults to a check in 24 hours.",
      parameters: Type.Object({ kind: workKindField, title: definition.title,
        instruction: Type.Optional(definition.instruction), trigger: Type.Optional(definition.trigger), inputId: Type.Optional(id),
        progress: Type.Optional(id), question: Type.Optional(id), checkAt: Type.Optional(Type.String({ format: "date-time" })) }, { additionalProperties: false }),
      async execute(callId, { kind, title, inputId, instruction, trigger, progress, question, checkAt }, signal) {
        signal?.throwIfAborted();
        if (kind === "ongoing") {
          if (instruction !== undefined || trigger !== undefined || inputId !== undefined) throw new Error("Ongoing accepts title, progress, question and checkAt");
          return result(await work.create({ kind, title, progress, question, checkAt }, undefined, callId));
        }
        if (progress !== undefined || question !== undefined || checkAt !== undefined) throw new Error("Only Ongoing accepts progress, question or checkAt");
        if (kind === "task" && !inputId) throw new Error("Task creation requires inputId; use the received Input or create an independent Chief request first");
        if (!instruction || trigger === undefined) throw new Error("Task and Routine require instruction and trigger");
        return result(await work.create({ kind, title, instruction, trigger }, inputId, callId));
      },
    }),
    tool({ name: "append_input", label: "Append input", description: "Send material or a decision to an existing Task or Routine. Set input.id to reference original material (a member ID for a batch). For a new Chief decision within existing authority, supply input.text and optionally input.id. Inline creation and attachment commit together. Returns inputId.",
      parameters: Type.Object({ workId: id, input: Type.Object({ id: Type.Optional(id), text: Type.Optional(Type.String({ minLength: 1, maxLength: 32000 })) }, { minProperties: 1, additionalProperties: false }), note: Type.Optional(id),
        action: Type.Optional(Type.Union([Type.Literal("context"), Type.Literal("update"), Type.Literal("answer"), Type.Literal("resume"), Type.Literal("pause")])),
        changes: Type.Optional(Type.Partial(Type.Object({ title: definition.title, instruction: definition.instruction, trigger: definition.trigger }, { additionalProperties: false }))),
      }, { additionalProperties: false }),
      async execute(callId, { workId, input, ...args }, signal) {
        signal?.throwIfAborted();
        return result(await work.appendInput(workId, input, args, callId));
      },
    }),
    tool({ name: "delete_work", label: "Delete work",
      description: "Delete an explicitly unwanted Task or Routine using its latest revision. Keeps topic messages; does not undo external actions or cancel an already running command.",
      parameters: Type.Object({ id, revision }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        signal?.throwIfAborted(); await work.delete(args.id, args.revision); return result({ id: args.id, deleted: true });
      },
    }),
  ];
}
