import { writeSummary } from "../note/summary.ts";
import { listNotes } from "../note/query.ts";
import { contentVersion } from "../context-write.ts";
import { WriterResourceSchema, SubjectSchema } from "../note/model.ts";
import { resourceRef } from "../input/state.ts";
import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Resource, ResourceClient } from "@compforge/aide-plugin";
import type { Logger } from "pino";
import { noteDescription, noteFields, summaryDescription } from "../execution/agent/context-tools.ts";
import { readNote, upsertNote } from "../note/service.ts";
import type { WorkSpec } from "./resources.ts";
import type { WorkAgentStatus } from "./agent-status.ts";
const tool = <T extends TSchema>(definition: ToolDefinition<T>): ToolDefinition<T> => definition;
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });

/** @spec Work agents can maintain only their live, host-bound resource; neither operation acknowledges Inputs. */
export function workContextTools(kind: "task" | "routine", resources: ResourceClient,
  current: () => Resource<WorkSpec, WorkAgentStatus>, log: Logger): ToolDefinition[] {
  const read = () => {
    const resource = current();
    if (resource.metadata.deletionTimestamp || !resource.status.execution || resource.kind.toLowerCase() !== kind) throw new Error(`${kind} execution is no longer active`);
    return resource;
  };
  return [
    tool({ name: "list_notes", label: "Find Work Notes", description: "Discover Notes by name/body q. Defaults to this Work; use a directory's subject/people/addresses filter for related evidence. Reading grants no authority to edit other resources. Each call scans one bounded page; follow continue even when a page has no matches. Use read_note for complete content.",
      parameters: Type.Object({ subject: Type.Optional(Type.String({ minLength: 1 })), people: Type.Optional(Type.String({ minLength: 1 })), addresses: Type.Optional(Type.String({ minLength: 1 })), isSummary: Type.Optional(Type.Boolean()), q: Type.Optional(Type.String({ maxLength: 500 })), continue: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }, { additionalProperties: false }),
      async execute(_id, args) { const owner = read(); return result(await listNotes(resources, { ...args, ...(!args.subject && !args.people && !args.addresses ? { subject: owner.metadata.uid } : {}) })); } }),
    tool({ name: "read_note", label: "Read note", description: "Read a complete Note identified by a directory or citation, including its name, body and version. Reading evidence grants no ownership or permission to change its subject.",
      parameters: Type.Object({ noteId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      async execute(_id, args) {
        read(); const note = await readNote(resources, args.noteId);
        return result(note);
      } }),
    tool({ name: `summarize_${kind}`, label: `Summarize ${kind}`, description: `${summaryDescription} Retain findings, constraints and conclusions that remain useful within this ${kind === "task" ? "task's lifetime" : "ongoing responsibility"}. The Host binds the target. Never changes the objective, schedule or business status.`,
      parameters: Type.Object({ version: Type.String({ minLength: 1 }), summary: Type.String({ maxLength: 16000 }), nature: noteFields.nature, maxChars: noteFields.maxChars, people: noteFields.people, sensitivity: noteFields.sensitivity, visibility: noteFields.visibility }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        signal?.throwIfAborted(); const owner = read();
        if (contentVersion(owner) !== args.version) throw new Error(`${kind} summary version conflict; read it again`);
        const updated = await writeSummary(resources, owner, { nature: args.nature, maxChars: args.maxChars, text: args.summary, people: args.people, sensitivity: args.sensitivity, visibility: args.visibility },
          { resource: WriterResourceSchema.parse(resourceRef(owner)), executionId: owner.status.execution!.id }, args.version);
        log.info({ workUid: owner.metadata.uid, executionId: owner.status.execution!.id, kind, version: contentVersion(updated) }, "Work summary updated");
        return result({ version: contentVersion(updated) });
      } }),
    tool({ name: "upsert_note", label: "Upsert note", description: `${noteDescription} Supply nature when creating an ordinary Note. Record knowledge learned during this work when it will help another decision. The Host binds the target. This does not replace report_work for done/wait/ask outcomes.`,
      parameters: Type.Object(noteFields, { additionalProperties: false }),
      async execute(callId, args, signal) {
        signal?.throwIfAborted(); const owner = read();
        const value = await upsertNote(resources, owner, args, `${owner.status.execution!.id}:${callId}`);
        log.info({ workUid: owner.metadata.uid, executionId: owner.status.execution!.id, kind, noteId: value.noteId, version: value.version, sensitivity: value.sensitivity, visibility: value.visibility }, "Work Note updated");
        return result(value);
      } }),
  ];
}
