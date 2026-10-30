import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResourceClient } from "@compforge/aide-plugin";
import type { Logger } from "pino";
import type { TopicResource } from "../topic/model.ts";
import { subjectField } from "../../../agents/context-tools.ts";
import { listNotes } from "./query.ts";
import { MoveNoteSchema, moveNote, reviewNotes } from "./operations.ts";
const text = Type.String({ minLength: 1 });
const result = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }], details: {} });
export function noteTools(resources: ResourceClient, active: () => TopicResource, log?: Logger): ToolDefinition[] {
  return [{ name: "list_notes", label: "Find matter Notes", description: "Discover retained Notes beyond recent. Filter by subject UID, Person UID in people, and/or text q. Each call scans at most 20 indexed records and previews 500 characters per match. A page can have no matches and still have continue: follow it for remaining records. Read complete Notes with read_note before editing or reviewing.",
    parameters: Type.Object({ subject: Type.Optional(text), people: Type.Optional(text), q: Type.Optional(Type.String({ maxLength: 500 })), continue: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }, { additionalProperties: false }),
    async execute(_id, args) { return result(await listNotes(resources, args)); } },
  { name: "move_note", label: "Move matter Note", description: "Move a Note to a Topic, Task or Routine in your current root tree. Read it first; supply version and reason. Both source and target must be in your current tree. Preserves identity, text, people and content age. Does not move Inputs or acknowledge processing.",
    parameters: Type.Object({ noteId: text, version: text, subject: subjectField, reason: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }),
    async execute(_id, args) { const input = MoveNoteSchema.parse(args); const value = await moveNote(resources, active(), input); log?.info({ ...value, subject: input.subject, reason: input.reason }, "Note moved"); return result(value); } },
  { name: "review_notes", label: "Confirm Note review", description: "After inspecting complete Notes, optionally updating Topic/Person summaries or organizing this tree, confirm exactly the reviewed versions. No summary change is required when nothing durable should be retained. Up to 20 Notes; each must belong to your current responsibility. Review preserves content version and retention age.",
    parameters: Type.Object({ notes: Type.Array(Type.Object({ noteId: text, version: text }), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }),
    async execute(_id, args) { const value = await reviewNotes(resources, active(), args); log?.info({ topicUid: active().metadata.uid, ...value }, "Note review confirmed"); return result(value); } }];
}
