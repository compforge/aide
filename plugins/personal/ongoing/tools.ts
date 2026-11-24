import { Type, type TSchema } from "typebox";
import type { ResourceClient } from "@compforge/aide-plugin";
import type { Logger } from "pino";
import { BUSINESS_INPUT_ORIGINS, type ChiefToolDefinition } from "../chief/agent/input-tools.ts";
import type { TopicResource } from "../topic/model.ts";
import { upsertOngoing } from "./service.ts";

const tool = <T extends TSchema>(definition: ChiefToolDefinition<T>) => definition;
const text = Type.String({ minLength: 1 });
const result = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }], details: {} });
export function ongoingTools(resources: ResourceClient, active: () => TopicResource, log?: Logger): ChiefToolDefinition[] {
  return [tool({ name: "update_ongoing", inputOrigins: [...BUSINESS_INPUT_ORIGINS, "aide:followup"], label: "Track ongoing matter",
    description: "Track one evolving matter until an evidenced conclusion. Supply the id and version returned by read_work. Record progress, schedule the next check, or close with outcome and basis. Omitted fields keep their values. checkAt=null clears the timer while waiting for an external reply; question=null clears the specific question.",
    parameters: Type.Object({ id: text, version: text, title: Type.Optional(text),
      progress: Type.Optional(text), outcome: Type.Optional(text), question: Type.Optional(Type.Union([text, Type.Null()])),
      checkAt: Type.Optional(Type.Union([Type.String({ format: "date-time" }), Type.Null()])) }, { additionalProperties: false }),
    async execute(callId, { id, ...args }) {
      if (!id) throw new Error("Updating Ongoing requires its id");
      const matter = await upsertOngoing(resources, active(), { ongoingId: id, ...args }, callId);
      log?.info({ ongoingId: id, topicUid: matter.topic.uid, checkAt: matter.checkAt, closed: !!matter.closure }, "Ongoing updated");
      return result(matter);
    } })];
}
