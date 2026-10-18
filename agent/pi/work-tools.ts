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
      description: "List this conversation's tasks and routines. Check for related work before creating a new item.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_id, _args, signal) { signal?.throwIfAborted(); return result(work.list()); },
    }),
    tool({ name: "read_work", label: "Read work",
      description: "Read a task or routine, including revision, status, history and pending question. Reading never resumes execution.",
      parameters: Type.Object({ id }, { additionalProperties: false }),
      async execute(_id, args, signal) { signal?.throwIfAborted(); return result(work.read(args.id)); },
    }),
    tool({ name: "create_work", label: "Create work",
      description: "Entrust a finite goal (task) or ongoing responsibility (routine) to Aide. Ordinary questions and immediate CLI queries do not need work items. Task trigger must be null; routine needs cron or event.",
      parameters: Type.Object(definition, { additionalProperties: false }),
      async execute(_id, args, signal) { signal?.throwIfAborted(); return result(work.create(args)); },
    }),
    tool({ name: "update_work", label: "Update work",
      description: "Use the latest revision. update changes the definition, without changing task/routine kind; answer supplies a note to waiting work; resume explicitly continues work; pause stops future execution. Verify uncertain/invalid_result history before resuming. To change kind, create a new work item and pause or delete the original as appropriate. Cannot declare completion.",
      parameters: Type.Object({ id, revision,
        action: Type.Union([Type.Literal("update"), Type.Literal("answer"), Type.Literal("resume"), Type.Literal("pause")]),
        changes: Type.Optional(Type.Partial(Type.Object({ title: definition.title, instruction: definition.instruction, trigger: definition.trigger }, { additionalProperties: false }))),
        note: Type.Optional(Type.String({ minLength: 1 })),
      }, { additionalProperties: false }),
      async execute(_id, { id, ...args }, signal) { signal?.throwIfAborted(); return result(work.update(id, args)); },
    }),
    tool({ name: "delete_work", label: "Delete work",
      description: "Delete explicitly unwanted work using its latest revision. Keeps conversation messages; does not undo external actions or cancel an already running command.",
      parameters: Type.Object({ id, revision }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        signal?.throwIfAborted(); work.delete(args.id, args.revision); return result({ id: args.id, deleted: true });
      },
    }),
  ];
}
