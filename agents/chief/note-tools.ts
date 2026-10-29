import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { NoteUpdate } from "../../plugins/personal/note/service.ts";
import { noteDescription, noteFields } from "../context-tools.ts";
export function chiefNoteTools(upsert?: (input: NoteUpdate, callId: string) => Promise<unknown>, beforeMutation?: () => void, read?: (id: string) => Promise<unknown>): ToolDefinition[] {
  if (!upsert) return [];
  const reads: ToolDefinition[] = read ? [{ name: "read_note", label: "Read note", description: "Read one complete independent Note, including its content version and subject. Use this when recent or background text was truncated.",
    parameters: Type.Object({ noteId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    async execute(_id, args) { return { content: [{ type: "text", text: JSON.stringify(await read((args as { noteId: string }).noteId)) }], details: {} }; },
  }] : [];
  return [...reads, { name: "upsert_note", label: "Upsert note", description: `${noteDescription} subject defaults to the current Topic. Other subjects must belong to this Topic subtree. Associate people directly; no separate Person Note operation is needed.`,
    parameters: Type.Object(noteFields, { additionalProperties: false }),
    async execute(callId, args, signal) {
      signal?.throwIfAborted(); beforeMutation?.();
      return { content: [{ type: "text", text: JSON.stringify(await upsert(args as NoteUpdate, callId)) }], details: {} };
    } }];
}
