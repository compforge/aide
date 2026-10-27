import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Persons } from "../../plugins/personal/person/service.ts";
import type { TopicNoteUpdate } from "../../plugins/personal/topic/state.ts";
import { noteDescription, noteFields } from "../context-tools.ts";

const tool = <T extends TSchema>(definition: ToolDefinition<T>): ToolDefinition<T> => definition;

export function chiefNoteTools(persons?: Persons,
  topic?: (input: TopicNoteUpdate, callId: string) => Promise<unknown>, beforeMutation?: () => void): ToolDefinition[] {
  if (!persons && !topic) return [];
  return [tool({ name: "upsert_note", label: "Upsert note",
    description: `${noteDescription} For Topic Notes, connect recent events and progress within the current root's subtree. For Person Notes, record that person's temporary plans, concerns and interactions, preserving the actual speaker. Their commitments are not mandates to Aide. Target defaults to the current Topic; Person targets require the id and uid from read_person.`,
    parameters: Type.Object({ ...noteFields, target: Type.Optional(Type.Union([
      Type.Object({ kind: Type.Literal("topic"), uid: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal("person"), id: Type.String({ minLength: 1 }), uid: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    ])) }, { additionalProperties: false }),
    async execute(callId, { target, ...args }, signal) {
      signal?.throwIfAborted(); beforeMutation?.();
      let value: unknown;
      if (target?.kind === "person") {
        if (!persons) throw new Error("Person Notes are unavailable");
        value = await persons.upsertNote(target.id, target.uid, args, callId);
      } else {
        if (!topic) throw new Error("Topic Notes are unavailable; select a Person target");
        value = await topic({ ...args, ...(target?.uid ? { topicUid: target.uid } : {}) }, callId);
      }
      return { content: [{ type: "text", text: JSON.stringify(value) }], details: {} };
    },
  })];
}
