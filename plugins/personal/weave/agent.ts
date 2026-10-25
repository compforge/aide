import { weaveCandidates, candidatePage } from "./candidates.ts";
import { identityBackground } from "../../../agents/personal.ts";
import type { Persons } from "../person/service.ts";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiSessionFactory } from "../../../src/host/harness/pi/adapter.ts";
import type { PiConfig } from "../../../src/host/harness/pi/config.ts";
import type { ExecutionScope } from "../../../src/protocol/verbs.ts";
import type { Manager } from "../../../src/host/plugin/manager.ts";
import type { Store } from "../store.ts";
import { createWeaveAgent } from "../../../agents/weave/agent.ts";
import { WEAVE_TYPE, type WeaveStatus } from "./model.ts";
import { planGroup } from "./service.ts";
import { TOPIC_TYPE, type TopicSpec, type TopicStatus } from "../topic/model.ts";
import { understandingVersion } from "../topic/tree.ts";
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
export function weaveSession(scope: ExecutionScope, config: PiConfig, store: Store, plugins: Manager, summaryChars: number, batchSize: number, persons?: Persons): PiSessionFactory {
  const ref = scope.resourceRef;
  if (scope.pluginInstanceId !== "personal" || ref?.kind !== "Weave" || !ref.uid) throw new Error("Weave requires its resource scope");
  return async options => {
    const active = () => {
      const resource = store.resources.get<Record<string, never>, WeaveStatus>(WEAVE_TYPE, ref.name, ref.namespace);
      if (resource.metadata.uid !== ref.uid || resource.metadata.deletionTimestamp || !resource.status.execution) throw new Error("Weave execution is not active");
      plugins.executionVerbs(resource.status.execution.id, {});
      return resource;
    };
    const roots = () => {
      active();
      return weaveCandidates(store.resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE));
    };
    const tools: ToolDefinition[] = [
      { name: "list_topics", label: "List root topics", description: "One bounded batch of root summaries, oldest inactive first. Search for related peers; do not expand the entire catalog.",
        parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })), query: Type.Optional(Type.String()) }),
        async execute(_id, { offset = 0, query }) {
          return result(candidatePage(roots().filter(t => !query || [t.spec.name, t.status.summary].join(" ").toLowerCase().includes(query.toLowerCase())), offset, batchSize));
        } },
      { name: "read_topic", label: "Read root topic", description: "Read full root understanding in bounded text pages. version pins the understanding used by group_topics.",
        parameters: Type.Object({ uid: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
        async execute(_id, { uid, offset = 0 }) {
          const t = roots().find(t => t.metadata.uid === uid);
          if (!t) throw new Error("Root Topic unavailable");
          const text = JSON.stringify({ name: t.spec.name, summary: t.status.summary, recent: t.status.recent });
          return result({ uid, version: understandingVersion(t), text: text.slice(offset, offset + 8000), nextOffset: offset + 8000 < text.length ? offset + 8000 : null });
        } },
      { name: "group_topics", label: "Group topics", description: "Propose a new parent containing 2-8 roots. Summary must preserve material understanding, explicit authors and confirmation state from every child. Never resolve an ambiguous I as Me or promote Aide proposals to user decisions. This schedules a safe handoff.",
        parameters: Type.Object({ topics: Type.Array(Type.Object({ uid: Type.String(), version: Type.String() }), { minItems: 2, maxItems: 8 }),
          name: Type.String({ minLength: 1, maxLength: 200 }), summary: Type.String({ minLength: 1, maxLength: summaryChars }) }),
        async execute(_id, args) { return result(await planGroup(plugins.resourceClient("personal"), active(), args, summaryChars)); } },
    ];
    return createWeaveAgent({ ...options, config, scope: `weave:${ref.uid}`, tools, background: identityBackground(persons) });
  };
}
