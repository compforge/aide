import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Persons } from "../../plugins/personal/person/service.ts";
const tool = <T extends TSchema>(definition: ToolDefinition<T>): ToolDefinition<T> => definition;
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
/** @spec Chief revises understanding, preserving user corrections in summary; never changes identities or Me marks. */
export function personTools(persons: Persons, beforeMutation?: () => void): ToolDefinition[] {
  return [
    tool({ name: "list_persons", label: "List persons", description: "Find known people across conversations. Names are not unique. Read a person before revising their profile.",
      parameters: Type.Object({}), async execute() { return result((await persons.list()).map((p) => ({ id: p.metadata.name, name: p.spec.name, isMe: p.isMe }))); } }),
    tool({ name: "read_person", label: "Read person", description: "Read identities, current summary, recent evidence and resource version.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }) }), async execute(_id, args) { return result(await persons.read(args.id)); } }),
    tool({ name: "profile_person", label: "Profile person", description: "Replace summary with concise cumulative understanding and supply recent describing the new observation or correction. Merge durable facts, correct outdated beliefs and remove repetition. Preserve explicit user corrections. Distinguish direct statements from inference, include relevant dates and context, and do not store Input IDs. Supply uid and version from read_person; on conflict reread and merge. Changes only summary and recent, never identities or Me.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }), uid: Type.String({ minLength: 1 }), version: Type.String({ minLength: 1 }), summary: Type.String({ maxLength: 16000 }), recent: Type.String({ minLength: 1, maxLength: 16000 }) }),
      async execute(_id, args, signal) { signal?.throwIfAborted(); beforeMutation?.(); return result(await persons.profile(args.id, args.uid, args.version, args.summary, args.recent)); } }),
  ];
}
