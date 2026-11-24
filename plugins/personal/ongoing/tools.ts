import { Type, type TSchema } from "typebox";
import type { ResourceClient } from "@compforge/aide-plugin";
import type { Logger } from "pino";
import { BUSINESS_INPUT_ORIGINS, INPUT_ORIGINS, type ChiefToolDefinition } from "../chief/agent/input-tools.ts";
import { isGateTopic } from "../topic/boundary.ts";
import { readTopicInScope } from "../topic/tree.ts";
import type { TopicResource } from "../topic/model.ts";
import { ONGOING_TYPE, ongoingView, type OngoingSpec, type OngoingStatus } from "./model.ts";
import { readOngoing, upsertOngoing } from "./service.ts";

const tool = <T extends TSchema>(definition: ChiefToolDefinition<T>) => definition;
const text = Type.String({ minLength: 1 });
const result = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }], details: {} });
export function ongoingReadTools(resources: ResourceClient, active: () => TopicResource): ChiefToolDefinition[] {
  return [tool({ name: "list_ongoings", inputOrigins: INPUT_ORIGINS, label: "List ongoing matters",
    description: "List open matters for one Topic in your tree (default: current root). Page with continue. Include closed matters to find an earlier outcome.",
    parameters: Type.Object({ topicUid: Type.Optional(text), includeClosed: Type.Optional(Type.Boolean()), continue: Type.Optional(text) }, { additionalProperties: false }),
    async execute(_id, args) {
      const owner = active();
      const uid = args.topicUid ?? owner.metadata.uid;
      if (!isGateTopic(owner) && !await readTopicInScope(resources, owner, uid)) throw new Error("Topic outside current tree");
      const page = await resources.page<OngoingSpec, OngoingStatus>(ONGOING_TYPE, { limit: 20, continue: args.continue,
        matchIndex: { name: args.includeClosed ? "topic" : "openTopic", value: uid } });
      return result({ items: page.items.map(m => ({ ongoingId: m.metadata.name, title: m.spec.title, checkAt: m.spec.checkAt, closedAt: m.status.closure?.at })), continue: page.metadata.continue });
    } }),
  tool({ name: "read_ongoing", inputOrigins: INPUT_ORIGINS, label: "Read ongoing matter", description: "Read the current progress, check plan, outcome and version of an Ongoing in your tree.",
    parameters: Type.Object({ ongoingId: text }), async execute(_id, args) { return result(ongoingView(await readOngoing(resources, active(), args.ongoingId))); } })];
}
export function ongoingTools(resources: ResourceClient, active: () => TopicResource, log?: Logger): ChiefToolDefinition[] {
  return [...ongoingReadTools(resources, active),
  tool({ name: "upsert_ongoing", inputOrigins: [...BUSINESS_INPUT_ORIGINS, "aide:followup"], label: "Track ongoing matter",
    description: "Track one evolving matter until an evidenced conclusion. Before creating, check existing matters. Create with title; first check defaults to 24 hours. Update with ongoingId and current version. Record progress, schedule the next check, or close with outcome and basis. Omitted fields keep their values. checkAt=null clears the timer while waiting for an external reply; question=null clears the specific question.",
    parameters: Type.Object({ ongoingId: Type.Optional(text), version: Type.Optional(text), title: Type.Optional(text),
      progress: Type.Optional(text), outcome: Type.Optional(text), question: Type.Optional(Type.Union([text, Type.Null()])),
      checkAt: Type.Optional(Type.Union([Type.String({ format: "date-time" }), Type.Null()])) }, { additionalProperties: false }),
    async execute(id, args) {
      const matter = await upsertOngoing(resources, active(), args, id);
      log?.info({ ongoingId: matter.ongoingId, topicUid: matter.topic.uid, checkAt: matter.checkAt, closed: !!matter.closure }, "Ongoing updated");
      return result(matter);
    } })];
}
