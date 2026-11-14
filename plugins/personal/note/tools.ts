import { Type } from "typebox";
import { INPUT_ORIGINS, type ChiefToolDefinition } from "../../../agents/chief/input-tools.ts";
import type { ResourceClient } from "@compforge/aide-plugin";
import type { Logger } from "pino";
import type { TopicResource } from "../topic/model.ts";
import { subjectField } from "../../../agents/context-tools.ts";
import { pruneNote, retireNote } from "./service.ts";
import { listNotes } from "./query.ts";
import { MoveNoteSchema, moveNote } from "./operations.ts";
const text = Type.String({ minLength: 1 });
const result = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }], details: {} });
export function noteTools(resources: ResourceClient, active: () => TopicResource, log?: Logger): ChiefToolDefinition[] {
  return [{ name: "prune_note", inputOrigins: ["aide:review"], label: "Prune Note",
    description: "Subtract information from an existing Note, including a summary. Read it first; provide its current version, reason and the complete shorter nonempty remaining text. Preserve classification and associations. If moving knowledge, first upsert the destination or update its summary and confirm success. Keep necessary evidence, attribution and unresolved questions. Use retire_note when nothing independently useful remains.",
    parameters: Type.Object({ noteId: text, version: text, text: Type.String({ minLength: 1, maxLength: 16000 }), reason: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }),
    async execute(id, args) { const value = await pruneNote(resources, active(), args, id); log?.info({ ...value, reason: (args as { reason: string }).reason }, "Note pruned"); return result(value); } },
  { name: "retire_note", inputOrigins: ["aide:review"], label: "Retire Note",
    description: "Remove a whole Note from active use, retaining its body and existing citations. Read first and provide its version and reason. Save any useful information elsewhere and confirm the target write before retiring. A summary whose owner still exists cannot be retired. Retired Notes cannot be edited or reactivated.",
    parameters: Type.Object({ noteId: text, version: text, reason: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }),
    async execute(_id, args) { const value = await retireNote(resources, active(), args); log?.info({ ...value }, "Note retired"); return result(value); } },
  { name: "list_notes", inputOrigins: INPUT_ORIGINS, label: "Find Notes", description: "Discover active retained Notes, including summary Notes, beyond recent. Filter by subject UID, Person UID in people, and/or text q. Each call scans at most 20 indexed records and previews 500 characters per match. A page can have no matches and still have continue: follow it for remaining records. Read complete Notes with read_note before editing or reviewing.",
    parameters: Type.Object({ subject: Type.Optional(text), people: Type.Optional(text), addresses: Type.Optional(text), q: Type.Optional(Type.String({ maxLength: 500 })), continue: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }, { additionalProperties: false }),
    async execute(_id, args) { return result(await listNotes(resources, args)); } },
  { name: "move_note", inputOrigins: ["aide:review", "aide:triage"], label: "Move matter Note", description: "Move a Note to a Topic, Task or Routine in your current root tree. Read it first; supply version and reason. Both source and target must be in your current tree. Preserves identity, text, people and content age. Does not move Inputs or acknowledge processing.",
    parameters: Type.Object({ noteId: text, version: text, subject: subjectField, reason: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }),
    async execute(_id, args) { const input = MoveNoteSchema.parse(args); const value = await moveNote(resources, active(), input); log?.info({ ...value, subject: input.subject, reason: input.reason }, "Note moved"); return result(value); } }];
}
