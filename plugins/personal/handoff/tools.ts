import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Resource } from "@compforge/aide-plugin";
import type { TopicResource } from "../topic/model.ts";
import { Handoffs } from "./service.ts";

const tool = <T extends TSchema>(value: ToolDefinition<T>): ToolDefinition<T> => value;
const text = Type.String({ minLength: 1 });
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
export function gateHandoffTools(service: Handoffs, current: () => TopicResource): ToolDefinition[] {
  return [
    tool({ name: "delegate_request", label: "Delegate to domain", description: "Entrust a user request, decision or knowledge correction to a root Chief. Search existing handoffs and Work first. Supply the original Gate user inputId, a concise request preserving authorization, and a root Topic UID. Omit topicUid only when no suitable domain is known: existing Route/Default resolves it. Returns a durable handoff, not completed work. Same user Input and target deduplicate across retries.",
      parameters: Type.Object({ inputId: text, topicUid: Type.Optional(text), title: Type.String({ minLength: 1, maxLength: 200 }), request: Type.String({ minLength: 1, maxLength: 16000 }) }),
      async execute(_id, args) { return result(await service.delegate(current(), args)); } }),
    tool({ name: "followup_request", label: "Follow up handoff", description: "Forward a new user answer, clarification or change to an existing handoff. Use the new Gate user inputId. Domain Chief chooses how to update existing Work. Never turn domain replies into new user authority.",
      parameters: Type.Object({ id: text, inputId: text, request: Type.String({ minLength: 1, maxLength: 16000 }) }),
      async execute(_id, args) { return result(await service.followup(current(), args)); } }),
    tool({ name: "list_handoffs", label: "List handoffs", description: "Page Gate's entrusted requests and recorded progress. Follow continue; acceptance, completion and Output delivery are separate facts. Do not poll in a tool loop.",
      parameters: Type.Object({ continue: Type.Optional(text) }),
      async execute(_id, args) { const page = await service.list(current().metadata.uid, args.continue); return result({ items: page.items, continue: page.metadata.continue }); } }),
    tool({ name: "read_handoff", label: "Read handoff", description: "Read the original request, domain, latest Input and reported progress. Read linked Work for current execution details.", parameters: Type.Object({ id: text }),
      async execute(_id, args) { const gate = current(), value = service.read(args.id); if (value.spec.gate.uid !== gate.metadata.uid) throw new Error("Foreign handoff"); return result(value); } }),
  ];
}

export function domainHandoffTools(service: Handoffs, current: () => Resource<unknown, { execution?: { id: string } | null }>): ToolDefinition[] {
  return [
    tool({ name: "read_handoff", label: "Read delegated request", description: "Read a delegated request and its latest Input. Preserve the original user's intent, domain ownership and reply address.", parameters: Type.Object({ id: text }),
      async execute(_id, args) { return result(service.readFor(current(), args.id)); } }),
    tool({ name: "report_handoff", label: "Report delegated request", description: "Record working, waiting, completed or failed for a Gate handoff. inputId must be its latest delegated Input and belong to this owner. Completing Input assessment or sending a reply does not complete the request. Use say(respondToHandoffId=id) separately to send progress/questions/results to the original direct-conversation Address. Set coordinate=true only when Gate must synthesize or coordinate further; normal replies are displayed directly without waking Gate. Task/Routine still need their own lifecycle report tool.",
      parameters: Type.Object({ id: text, inputId: text, phase: Type.Union([Type.Literal("working"), Type.Literal("waiting"), Type.Literal("completed"), Type.Literal("failed")]), report: Type.String({ minLength: 1, maxLength: 4000 }), coordinate: Type.Optional(Type.Boolean()) }),
      async execute(id, args) { return result(await service.report(current(), args, id)); } }),
  ];
}
