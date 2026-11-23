import { Type } from "typebox";
import { INPUT_ORIGINS, type ChiefToolDefinition } from "./input-tools.ts";
import type { TopicNoteUpdate } from "../../topic/state.ts";
import { summaryDescription, noteDescription, noteFields } from "../../execution/agent/context-tools.ts";
export function chiefNoteTools(upsert?: (input: TopicNoteUpdate, callId: string) => Promise<unknown>, beforeMutation?: () => void, read?: (id: string) => Promise<unknown>): ChiefToolDefinition[] {
  if (!upsert) return [];
  const { subject, ...fields } = noteFields;
  const reads: ChiefToolDefinition[] = read ? [{ name: "read_note", inputOrigins: INPUT_ORIGINS, label: "Read note", description: "Read one complete independent Note, including its content version and subject. Select a Note by its directory name, then read its complete body by stable noteId before relying on its details or editing it.",
    parameters: Type.Object({ noteId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    async execute(_id, args) { return { content: [{ type: "text", text: JSON.stringify(await read((args as { noteId: string }).noteId)) }], details: {} }; },
  }] : [];
  return [...reads, { name: "upsert_note", inputOrigins: INPUT_ORIGINS, label: "Upsert note", description: `${noteDescription} For a summary Note, ordinary Inputs may read it. During aide:curate you may edit a Topic, Person or Address summary, and during aide:organize only a Topic summary. Read the owner's summaryNote and use its noteId (id) and Note version. Only when it is absent, provide summaryOf with the owner's full reference and text. ${summaryDescription} For ordinary creation, omit topicId to attach to the current Chief root, or specify a Topic ID in its subtree. Updating noteId preserves its current subject; omit topicId and use move_note separately to relocate it. Associate people directly; no separate Person Note operation is needed.`,
    parameters: Type.Object({ ...fields, text: Type.Optional(Type.String({ maxLength: 16000, description: "Complete body. Empty text clears an existing summary only." })), summaryOf: Type.Optional(Type.Object({ apiVersion: Type.String(), kind: Type.Union([Type.Literal("Topic"), Type.Literal("Person"), Type.Literal("Address")]),
      namespace: Type.Literal("v1"), name: Type.String(), uid: Type.String() }, { additionalProperties: false })), topicId: Type.Optional(Type.String({ minLength: 1, description: "Creation only: spec.id from read_topic, not its UID. Target must be in this root tree; omit to use the Chief root." })) }, { additionalProperties: false }),
    async execute(callId, args, signal) {
      signal?.throwIfAborted(); beforeMutation?.();
      return { content: [{ type: "text", text: JSON.stringify(await upsert(args as TopicNoteUpdate, callId)) }], details: {} };
    } }];
}
