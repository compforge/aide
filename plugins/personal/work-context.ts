import { listNotes } from "./note/query.ts";
import { contentVersion } from "./context-write.ts";
import { SubjectSchema } from "./note/model.ts";
import { resourceRef } from "./input/state.ts";
import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Resource, ResourceClient } from "@compforge/aide-plugin";
import type { Logger } from "pino";
import { noteDescription, noteFields, summaryDescription } from "../../agents/context-tools.ts";
import { readNote, upsertNote } from "./note/service.ts";
import type { WorkSpec } from "./resources.ts";
import type { WorkAgentStatus } from "./work-status.ts";
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
    tool({ name: "list_notes", label: "Find Work Notes", description: "Find this Work's retained Notes beyond recent. Text q filters one bounded page; follow continue even when a page has no matches. Use read_note for complete content.",
      parameters: Type.Object({ q: Type.Optional(Type.String({ maxLength: 500 })), continue: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }, { additionalProperties: false }),
      async execute(_id, args) { return result(await listNotes(resources, { ...args, subject: read().metadata.uid })); } }),
    tool({ name: "read_note", label: "Read note", description: "Read the complete text and content version of one Note belonging to this Work.",
      parameters: Type.Object({ noteId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      async execute(_id, args) {
        const owner = read(), note = await readNote(resources, args.noteId);
        if (note.subject.uid !== owner.metadata.uid) throw new Error("Note belongs to another Work");
        return result(note);
      } }),
    tool({ name: `summarize_${kind}`, label: `Summarize ${kind}`, description: `${summaryDescription} Retain findings, constraints and conclusions that remain useful within this ${kind === "task" ? "task's lifetime" : "ongoing responsibility"}. The Host binds the target. Never changes the objective, schedule or business status.`,
      parameters: Type.Object({ version: Type.String({ minLength: 1 }), summary: Type.String({ maxLength: 16000 }) }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        signal?.throwIfAborted(); const owner = read();
        if (contentVersion(owner) !== args.version) throw new Error(`${kind} summary version conflict; read it again`);
        const updated = await resources.patch(owner, { type: "json", value: [
          { op: "test", path: "/status/summary", value: owner.status.summary },
          { op: "replace", path: "/status/summary", value: args.summary },
          { op: "add", path: "/status/contextWriter", value: { resource: SubjectSchema.parse(resourceRef(owner)), executionId: owner.status.execution!.id } },
        ] }).catch(error => {
          if (error instanceof Error && error.name === "TEST_OPERATION_FAILED")
            throw new Error(`${kind} summary version conflict; read_${kind} and merge again`, { cause: error });
          throw error;
        });
        log.info({ workUid: owner.metadata.uid, executionId: owner.status.execution!.id, kind, version: contentVersion(updated) }, "Work summary updated");
        return result({ version: contentVersion(updated) });
      } }),
    tool({ name: "upsert_note", label: "Upsert note", description: `${noteDescription} ${kind === "task"
      ? "Track this task's progress, blockers, attempts and verification results. Distinguish planned, executed and verified actions."
      : "Track this responsibility's recent checks, anomalies and follow-up. Update one Note for the same continuing anomaly or occurrence; distinct occurrences can have distinct Notes."} The Host binds the target. This does not replace report_${kind} for done/wait/ask outcomes.`,
      parameters: Type.Object(noteFields, { additionalProperties: false }),
      async execute(callId, args, signal) {
        signal?.throwIfAborted(); const owner = read();
        const value = await upsertNote(resources, owner, args, `${owner.status.execution!.id}:${callId}`);
        log.info({ workUid: owner.metadata.uid, executionId: owner.status.execution!.id, kind, noteId: value.noteId, version: value.version }, "Work Note updated");
        return result(value);
      } }),
  ];
}
