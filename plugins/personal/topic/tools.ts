import { reclamationVersion } from "./retention.ts";
import { SubjectSchema } from "../note/model.ts";
import { resourceRef } from "../input/state.ts";
import { noteTools } from "../note/tools.ts";
import { isInternalInput } from "../input/model.ts";
import { contentVersion } from "../context-write.ts";
import { notes } from "../note/query.ts";
import { topicPersons } from "./persons.ts";
import { createChildTopic, moveMaterial, moveTopic } from "./organize.ts";
import type { Logger } from "pino";
import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Store } from "../store.ts";
import type { TopicResource } from "./model.ts";
import { understandingVersion } from "./tree.ts";
import { contextPage, topicPage, understanding } from "../background.ts";
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
const tool = <T extends TSchema>(definition: ToolDefinition<T>): ToolDefinition<T> => definition;
/** Root agents may inspect their own subtree, never expand unrelated trees into automatic context. */
export function topicTools(store: Store, active: () => TopicResource, log?: Logger): ToolDefinition[] {
  const subtree = () => store.topics.scope(active().metadata.uid);
  const report = (resource: { kind: string; metadata: { uid: string }; status: unknown }) => {
    log?.info({ kind: resource.kind, uid: resource.metadata.uid, organization: (resource.status as { organization?: unknown }).organization }, "Chief organization applied");
    return result(resource);
  };
  return [...noteTools(store.client, active, log),
    tool({ name: "release_topic", label: "Allow Topic reclamation", description: "Explicitly allow capacity reclamation of a root whose current knowledge is dispensable or safely retained elsewhere. Read this Topic first and supply its reclamationVersion and reason. Does not delete now. New knowledge invalidates the decision. Default, busy Topics and live dependencies remain protected.",
      parameters: Type.Object({ uid: Type.Optional(Type.String()), version: Type.String(), reason: Type.String({ minLength: 1, maxLength: 2000 }) }),
      async execute(_id, args) {
        const actor = active(), topic = subtree().find(t => t.metadata.uid === (args.uid ?? actor.metadata.uid));
        if (!topic || !actor.status.execution || topic.spec.parentRef) throw new Error("Release requires an active Chief and a root Topic");
        if (reclamationVersion(topic, store.resources) !== args.version) throw new Error("Topic understanding changed; read_topic again");
        const updated = await store.client.patchStatus(topic, { reclamation: { version: args.version, reason: args.reason,
          writer: { resource: SubjectSchema.parse(resourceRef(actor)), executionId: actor.status.execution.id } } });
        log?.info({ topicUid: topic.metadata.uid, reason: args.reason }, "Topic approved for capacity reclamation");
        return result({ uid: updated.metadata.uid, eligibleWhenSafe: true });
      } }),
    tool({ name: "create_topic", label: "Create child Topic", description: "Create a meaningful child inside this root tree. Supply a stable scope and reason; do not split just to meet a count.",
      parameters: Type.Object({ parentUid: Type.Optional(Type.String()), name: Type.String({ minLength: 1, maxLength: 200 }), summary: Type.String({ maxLength: 4000 }), reason: Type.String({ minLength: 1, maxLength: 2000 }) }),
      async execute(id, args) { return report(await createChildTopic(store.client, active(), args, id)); } }),
    tool({ name: "move_input", label: "Move Input", description: "Move an Input's current ownership within this tree. Finish any admitted assessment first. Facts, routing history and processing receipts remain intact.",
      parameters: Type.Object({ inputId: Type.String(), topicUid: Type.String(), reason: Type.String({ minLength: 1, maxLength: 2000 }) }),
      async execute(_id, args) { return report(await moveMaterial(store.client, active(), { ...args, id: args.inputId, kind: "Input" })); } }),
    tool({ name: "move_work", label: "Move Work", description: "Move an idle Task or Routine within this tree; preserves objective, schedule, identity and progress. Retry after running work finishes.",
      parameters: Type.Object({ kind: Type.Union([Type.Literal("Task"), Type.Literal("Routine")]), id: Type.String(), topicUid: Type.String(), reason: Type.String({ minLength: 1, maxLength: 2000 }) }),
      async execute(_id, args) { return report(await moveMaterial(store.client, active(), args)); } }),
    tool({ name: "move_topic", label: "Reorganize Topic", description: "Move a descendant under another Topic in this tree, or use null parentUid to make its subtree independent. Wait for active processing in that subtree to finish. Explain the lasting boundary; Weave will see this reason.",
      parameters: Type.Object({ uid: Type.String(), parentUid: Type.Union([Type.String(), Type.Null()]), reason: Type.String({ minLength: 1, maxLength: 2000 }) }),
      async execute(_id, args) { return report(await moveTopic(store.client, active(), args)); } }),
    tool({ name: "list_inputs", label: "List Topic inputs", description: "Page through retained business Inputs directly assigned to a Topic in this tree, including already assessed material. Use read_input for full evidence before reorganizing.",
      parameters: Type.Object({ topicUid: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
      async execute(_id, { topicUid, offset = 0 }) {
        const root = active(), topic = subtree().find(t => t.metadata.uid === (topicUid ?? root.metadata.uid));
        if (!topic) throw new Error("Topic is outside this root");
        const items = store.topics.inputStore.query("topic", topic.metadata.uid).filter(i => !i.metadata.deletionTimestamp && !isInternalInput(i.spec));
        return result(contextPage(items.map(i => ({ id: i.metadata.name, topicUid: i.status.topic!.uid, text: i.spec.text.slice(0, 240), assessed: !!i.status.assess?.completedAt })), offset));
      } }),
    { name: "list_topics", label: "List child topics", description: "List direct children within this root's subtree with summary and Note previews for discovery. Text ending in [truncated] is incomplete; noteTotal counts Notes in the retained recent window, including omitted previews. Before relying on incomplete context or confirming absorbed versions, use read_topic(uid) and continue with offset=nextOffset until the needed context is read. Follow this list's nextOffset to discover remaining children.",
      parameters: Type.Object({ parentUid: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
      async execute(_id, { parentUid, offset = 0 }) {
        const root = active(), parent = parentUid ?? root.metadata.uid;
        const all = subtree();
        if (!all.some(t => t.metadata.uid === parent)) throw new Error("Topic is outside this root");
        return result(topicPage(all.filter(t => t.spec.parentRef?.uid === parent), t => ({
          uid: t.metadata.uid, name: t.spec.name, persons: topicPersons(store, t), ...understanding({ ...t.status, recent: notes(store.resources, t.metadata.uid) }, 1200), version: understandingVersion(t, notes(store.resources, t.metadata.uid)), organization: t.status.organization,
        }), offset));
      } },
    { name: "read_topic", label: "Read topic", description: "Read this root or a descendant's full summary and recent Note window in text pages. Use read_note for the complete text of a truncated Note. A non-null nextOffset means more text remains: continue with offset=nextOffset; null marks the end. Use its content version for summarize_topic and understandingVersion for absorbed receipts after reviewing the child context.",
      parameters: Type.Object({ uid: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
      async execute(_id, { uid, offset = 0 }) {
        const root = active(), topic = subtree().find(t => t.metadata.uid === (uid ?? root.metadata.uid));
        if (!topic) throw new Error("Topic is outside this root");
        const text = JSON.stringify({ ...topic.spec, persons: topicPersons(store, topic), conditions: topic.status.conditions, summaryDependencies: topic.status.summaryDependencies, summary: topic.status.summary, recent: notes(store.resources, topic.metadata.uid), organization: topic.status.organization });
        return result({ uid: topic.metadata.uid, version: contentVersion(topic), reclamationVersion: reclamationVersion(topic, store.resources), understandingVersion: understandingVersion(topic, notes(store.resources, topic.metadata.uid)),
          text: text.slice(offset, offset + 8000), nextOffset: offset + 8000 < text.length ? offset + 8000 : null });
      } },
  ];
}
