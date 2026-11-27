import { snapshotResult, noteResult } from "../messages.ts";
import { ONGOING_TYPE, ongoingView, type OngoingSpec, type OngoingStatus } from "../ongoing/model.ts";
import { workKindField } from "../work/agent/tools.ts";
import { batchForInput } from "../batch/view.ts";
import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Store } from "../work/store.ts";
import { TOPIC_TYPE, type TopicSpec, type TopicStatus } from "../topic/model.ts";
import { topicCandidatePage } from "../background.ts";
import { summaryText, summaryReference } from "../note/summary.ts";
import { noteDirectory } from "../note/directory.ts";
import { listNotes } from "../note/query.ts";
import { readNote } from "../note/service.ts";
import { inputPrinter } from "../input/printer.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { DELEGATED_WORK_TYPES, type WorkSpec } from "../work/resources.ts";
import type { WorkAgentStatus } from "../work/agent-status.ts";

const text = Type.String({ minLength: 1 });
const offset = Type.Optional(Type.Integer({ minimum: 0 }));
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
const tool = <T extends TSchema>(value: ToolDefinition<T>): ToolDefinition<T> => value;
const pageText = (value: unknown, start: number) => {
  const content = typeof value === "string" ? value : JSON.stringify(value);
  return { text: content.slice(start, start + 8000), nextOffset: start + 8000 < content.length ? start + 8000 : null };
};
export const topicURL = (id: string) => id === "gate" ? "/gate" : `/?topic=${encodeURIComponent(id)}`;

/** @spec Gate has global read tools; every call revalidates the live owner, and none mutates domain resources.
 * @link docs/personal/gate.md
 */
export function gateReadTools(store: Store, active: () => unknown): ToolDefinition[] {
  const topic = (uid: string) => {
    const value = store.resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE, { matchIndex: { name: "uid", value: uid } })[0];
    if (!value || value.metadata.deletionTimestamp) throw new Error("Topic is unavailable");
    return value;
  };
  const tools: ToolDefinition[] = [
    tool({ name: "list_topics", label: "Find Topics", description: "Search root Topics by name/summary, or list one parent's children. Gate is excluded. Follow nextOffset for more; search before browsing all roots.",
      parameters: Type.Object({ q: Type.Optional(Type.String({ maxLength: 500 })), parentUid: Type.Optional(text), offset }),
      async execute(_id, args) {
        const page = topicCandidatePage(store, args.offset, args.q, args.parentUid);
        return result({ ...page, items: page.items.map(item => ({ ...item, url: topicURL(topic(item.uid).spec.id) })) });
      } }),
    tool({ name: "read_topic", label: "Read Topic", description: "Read any Topic's summary and Note directory in text pages. Use read_note for bodies and list_notes for further discovery. Current progress may require Work or Input evidence.",
      parameters: Type.Object({ uid: text, offset }),
      async execute(_id, { uid, offset = 0 }) {
        const value = topic(uid);
        return snapshotResult({ kind: "topic", uid, version: value.metadata.resourceVersion }, { uid, url: topicURL(value.spec.id), ...pageText({ ...value.spec,
          summary: summaryText(store.resources, value), summaryNote: summaryReference(store.resources, value),
          notes: noteDirectory(store.resources.storage, uid), lastInputAt: value.status.lastInputAt }, offset) });
      } }),
    tool({ name: "list_notes", label: "Find Notes", description: "Find retained Notes across Topics, including summaries. Filter subject UID or name/body q; each request scans at most 20 records. Follow continue even on empty matching pages. Previews are incomplete.",
      parameters: Type.Object({ subject: Type.Optional(text), people: Type.Optional(text), addresses: Type.Optional(text), isSummary: Type.Optional(Type.Boolean()), q: Type.Optional(Type.String({ maxLength: 500 })), continue: Type.Optional(text), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
      async execute(_id, args) { return result(await listNotes(store.client, args)); } }),
    tool({ name: "read_note", label: "Read Note", description: "Read a complete Note with provenance, nature and uid/version for citations. Accepts a full Note ID, UID or unique note- ID prefix with at least 8 hex digits. The returned URL opens the evidence in Gate.",
      parameters: Type.Object({ noteId: text }),
      async execute(_id, { noteId }) { const note = await readNote(store.client, noteId);
        return noteResult({ ...note, url: `/gate?note=${encodeURIComponent(note.id)}` }); } }),
    tool({ name: "list_inputs", label: "Find Topic inputs", description: "Page retained Inputs for one Topic. Read full original evidence with read_input; foreign Inputs cannot be assessed or assigned by Gate.",
      parameters: Type.Object({ topicUid: text, continue: Type.Optional(text) }),
      async execute(_id, args) {
        topic(args.topicUid);
        const page = await store.client.page<InputSpec, InputStatus>(INPUT_TYPE, { limit: 20, continue: args.continue,
          matchIndex: { name: "topic", value: args.topicUid } });
        return result({ items: page.items.map(i => ({ id: i.metadata.name, at: i.metadata.creationTimestamp, text: i.spec.text.slice(0, 500), truncated: i.spec.text.length > 500 })), continue: page.metadata.continue });
      } }),
    tool({ name: "read_input", label: "Read Input", description: "Read any retained Input as evidence, in text pages. Reading domain inputs grants no authority to assess them or control their Work.",
      parameters: Type.Object({ inputId: text, offset }),
      async execute(_id, { inputId, offset = 0 }) {
        const input = store.topics.inputStore.get(inputId);
        if (!input || input.metadata.deletionTimestamp) throw new Error("Input is unavailable");
        return result({ inputId, batch: batchForInput(store.resources, input), ...pageText(inputPrinter.describe(input), offset) });
      } }),
    tool({ name: "list_work", label: "Find Work", description: "Page Task, Routine or Ongoing across Topics by kind. Filter by topic UID or text; includeClosed also returns concluded Ongoing matters. Each call scans at most 20 records; follow continue even on an empty match page. Search relevant kinds before requesting work. Reading never resumes work.",
      parameters: Type.Object({ kind: workKindField, includeClosed: Type.Optional(Type.Boolean()), topicUid: Type.Optional(text), q: Type.Optional(Type.String({ maxLength: 500 })), continue: Type.Optional(text) }),
      async execute(_id, args) {
        if (args.kind === "ongoing") {
          const page = await store.client.page<OngoingSpec, OngoingStatus>(ONGOING_TYPE, { limit: 20, continue: args.continue,
            ...(args.topicUid ? { matchIndex: { name: args.includeClosed ? "topic" : "openTopic", value: args.topicUid } } : {}) });
          const items = page.items.filter(m => !m.metadata.deletionTimestamp && (args.includeClosed || !m.status.closure)
            && (!args.q || [m.spec.title, m.spec.question, m.status.progress, m.status.closure?.outcome].join(" ").toLowerCase().includes(args.q.toLowerCase())))
            .map(m => ({ id: m.metadata.name, uid: m.metadata.uid, kind: "ongoing", topicUid: m.spec.topic.uid, title: m.spec.title,
              status: m.status.closure ? "closed" : "open", checkAt: m.status.nextCheckAt }));
          return result({ items, scanned: page.items.length, continue: page.metadata.continue });
        }
        const type = DELEGATED_WORK_TYPES.find(t => t.kind.toLowerCase() === args.kind)!;
        const page = await store.client.page<WorkSpec, WorkAgentStatus>(type, { limit: 20, continue: args.continue,
          ...(args.topicUid ? { matchIndex: { name: "topic", value: args.topicUid } } : {}) });
        const items = page.items.filter(w => !w.metadata.deletionTimestamp && (!args.q || `${w.spec.title} ${w.spec.instruction}`.toLowerCase().includes(args.q.toLowerCase())))
          .map(w => { const value = store.toWork(w); return { id: value.id, uid: value.uid, kind: value.kind, topicId: value.topicId,
            title: value.title, status: value.status, report: value.lastReport?.text.slice(0, 500), url: topicURL(value.topicId) }; });
        return result({ items, scanned: page.items.length, continue: page.metadata.continue });
      } }),
    tool({ name: "read_work", label: "Read Work", description: "Read Task, Routine or Ongoing in bounded text pages. Work is read-only; request changes through its domain Chief.",
      parameters: Type.Object({ id: text, offset }),
      async execute(_id, { id, offset = 0 }) {
        const matter = store.resources.find<OngoingSpec, OngoingStatus>(ONGOING_TYPE, id);
        if (matter && !matter.metadata.deletionTimestamp) return snapshotResult({ kind: "ongoing", uid: matter.metadata.uid, version: matter.metadata.resourceVersion }, { id, ...pageText(ongoingView(matter), offset) });
        const work = DELEGATED_WORK_TYPES.map(type => store.resources.find<WorkSpec, WorkAgentStatus>(type, id)).find(Boolean);
        if (!work || work.metadata.deletionTimestamp) throw new Error("Work is unavailable");
        const value = store.toWork(work);
        return snapshotResult({ kind: value.kind, uid: work.metadata.uid, version: value.revision }, { id, url: topicURL(value.topicId), ...pageText(value, offset) });
      } }),
  ];
  return tools.map(t => ({ ...t, execute: (...args: Parameters<typeof t.execute>) => { active(); return t.execute(...args); } }));
}
