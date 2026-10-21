import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Persons } from "../../plugins/personal/person/service.ts";
const tool = <T extends TSchema>(definition: ToolDefinition<T>): ToolDefinition<T> => definition;
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
/** @spec Chief revises understanding, never identities, Me marks or explicit user corrections. */
export function personTools(persons: Persons, beforeMutation?: () => void): ToolDefinition[] {
  return [
    tool({ name: "list_persons", label: "List persons", description: "Find known people across conversations. Names are not unique. Read a person before revising their profile.",
      parameters: Type.Object({}), async execute() { return result((await persons.list()).map((p) => ({ id: p.metadata.name, name: p.spec.name, isMe: p.isMe }))); } }),
    tool({ name: "read_person", label: "Read person", description: "Read identities, current understanding, explicit user corrections and resource version.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }), async execute(_id, args) { return result(await persons.read(args.id)); } }),
    tool({ name: "profile_person", label: "Profile person", description: "Save a concise revised understanding. Merge durable facts, correct outdated beliefs and remove repetition. Preserve explicit user corrections. Distinguish direct statements from inference, include relevant dates and context, and do not store Input IDs. Supply uid and version from read_person; on conflict reread and merge. Changes only understanding, never identities or Me.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }), uid: Type.String({ minLength: 1 }), version: Type.String({ minLength: 1 }), understanding: Type.String({ maxLength: 12000 }) }),
      async execute(_id, args, signal) { signal?.throwIfAborted(); beforeMutation?.(); return result(await persons.profile(args.id, args.uid, args.version, args.understanding)); } }),
  ];
}
