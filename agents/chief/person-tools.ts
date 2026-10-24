import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Persons } from "../../plugins/personal/person/service.ts";
const tool = <T extends TSchema>(definition: ToolDefinition<T>): ToolDefinition<T> => definition;
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
/** @spec Chief revises understanding, preserving user corrections in summary; never changes identities or Me marks. */
export function personTools(persons: Persons, beforeMutation?: () => void): ToolDefinition[] {
  return [
    tool({ name: "list_persons", label: "List persons", description: "Find known people across topics. Names are not unique. Read a person before revising their summary.",
      parameters: Type.Object({}), async execute() { return result((await persons.list()).map((p) => ({ id: p.metadata.name, name: p.spec.name, isMe: p.isMe }))); } }),
    tool({ name: "read_person", label: "Read person", description: "Read identities, current summary, recent evidence and resource version.",
      parameters: Type.Object({ id: Type.String({ minLength: 1, description: "Person metadata.name, or id returned by list_persons. For Input/Output references use ref.name here, not ref.uid or the channel user ID." }), uid: Type.Optional(Type.String({ minLength: 1, description: "Supply ref.uid separately when reading an Input/Output Person reference to verify the exact resource." })) }),
      async execute(_id, args) {
        try { return result(await persons.read(args.id, args.uid)); }
        // @spec An unmatched lookup does not prove deletion; wrong identifier kinds can produce the same result.
        catch (error) { if (!String(error).includes("Unknown Person")) throw error; return result({ found: false, id: args.id, message: "No Person matched the supplied id/uid. This does not establish deletion. Use ref.name as id and ref.uid separately, or list_persons; original message evidence remains available." }); }
      } }),
    tool({ name: "summary_person", label: "Summarize person", description: "Replace summary with concise cumulative understanding and supply recent describing the new observation or correction. Merge durable facts, correct outdated beliefs and remove repetition. Preserve explicit user corrections. Attribute evidence to its actual speaker. Aide suggestions do not establish this person's preferences or intentions; explicit adoption preserves the original author and adopted scope. Distinguish direct statements from inference, include relevant dates and context, and do not store Input IDs. Supply uid and version from read_person; on conflict reread and merge. Changes only summary and recent, never identities or Me.",
      parameters: Type.Object({ id: Type.String({ minLength: 1 }), uid: Type.String({ minLength: 1 }), version: Type.String({ minLength: 1 }), summary: Type.String({ maxLength: 16000 }), recent: Type.String({ minLength: 1, maxLength: 16000 }) }),
      async execute(_id, args, signal) { signal?.throwIfAborted(); beforeMutation?.(); return result(await persons.summarize(args.id, args.uid, args.version, args.summary, args.recent)); } }),
  ];
}
