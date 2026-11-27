import { messageBackground } from "../../../../agents/background.ts";
import { snapshotMessage } from "../../messages.ts";
import { appendGateInput } from "../handoff.ts";
import { isGateTopic } from "../../topic/boundary.ts";
import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";
import type { PiConfig } from "../../../../src/host/harness/pi/config.ts";
import type { PiSessionFactory } from "../../../../src/host/harness/pi/adapter.ts";
import type { ExecutionScope } from "../../../../src/protocol/verbs.ts";
import type { Manager } from "../../../../src/host/plugin/manager.ts";
import { createGateAgent } from "./agent.ts";
import { personContext } from "../../person/agent-context.ts";
import type { Persons } from "../../person/service.ts";
import type { MailSender } from "../../stream/sender.ts";
import type { Store } from "../../work/store.ts";

import { TOPIC_TYPE, type TopicSpec, type TopicStatus } from "../../topic/model.ts";
import { bindInputDelivery } from "../../chief/delivery.ts";

import { inputPreview } from "../../input/prompt.ts";
import { say } from "../../output/action.ts";
import { gateReadTools } from "../read-tools.ts";

const text = Type.String({ minLength: 1 });
const citations = Type.Array(Type.Object({ uid: text, version: text }), { maxItems: 100 });
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
const tool = <T extends TSchema>(value: ToolDefinition<T>): ToolDefinition<T> => value;

/** @spec Gate's global reads never widen its Input assessment or Work mutation scope.
 * @link docs/personal/gate.md
 */
export function gateSession(scope: ExecutionScope, config: PiConfig, store: Store, plugins: Manager, log: Logger,
  persons: Persons | undefined, mail: Pick<MailSender, "cite">): PiSessionFactory {
  const ref = scope.resourceRef;
  if (scope.pluginInstanceId !== "personal" || ref?.kind !== TOPIC_TYPE.kind || ref.apiVersion !== TOPIC_TYPE.apiVersion || !ref.uid)
    throw new Error("Gate requires its owning Topic scope");
  return async options => {
    const current = () => {
      const gate = store.resources.get<TopicSpec, TopicStatus>(TOPIC_TYPE, ref.name, ref.namespace);
      if (!isGateTopic(gate) || gate.metadata.uid !== ref.uid || gate.metadata.deletionTimestamp || !gate.status.execution)
        throw new Error("Gate execution is no longer active");
      plugins.executionVerbs(gate.status.execution.id, { topicId: gate.spec.id });
      return gate;
    };
    const tools: ToolDefinition[] = [
      ...gateReadTools(store, current),
      tool({ name: "append_input", label: "Forward to domain", description: "Forward a request from Me to its root Topic using the original Gate inputId. Use a new user Input for clarifications. The returned Input ID acknowledges forwarding.",
        parameters: Type.Object({ inputId: text, topicUid: text, text: Type.String({ minLength: 1, maxLength: 16000 }) }),
        async execute(_id, args) { const receipt = appendGateInput(store, current(), args); log.info({ ...receipt, sourceInputId: args.inputId }, "Gate Input forwarded"); return result(receipt); } }),
      tool({ name: "say", label: "Reply in Gate", description: "Reply to Me in the original direct conversation; specify respondToInputId when needed. With an active live Output, write assistant text instead of duplicating that reply. Acceptance does not prove delivery.",
        parameters: Type.Object({ text, notes: Type.Optional(citations), respondToInputId: Type.Optional(text) }),
        async execute(id, args) { const gate = current(); return result(await say(plugins.executionVerbs(gate.status.execution!.id, { topicId: gate.spec.id }), { ...args, idempotencyKey: id })); } }),
      tool({ name: "cite_output", label: "Cite live reply", description: "Attach all Notes used by the live reply, including summary Notes. Copy exact uid/version from read tools. Citations preserve disclosure and provenance for the entire Stream.",
        parameters: Type.Object({ notes: citations }),
        async execute(_id, args) { return result(mail.cite(current().status.execution!.id, args.notes)); } }),
    ];
    const session = await createGateAgent({ ...options, config, scope: `gate:${ref.uid}`,
      tools: tools.map(t => ({ ...t, execute: (...args: Parameters<typeof t.execute>) => { current(); return t.execute(...args); } })),
      background: async () => {
        const gate = current();
        const me = persons ? await personContext(persons) : "Me is not configured";
        const inputs = store.topics.inputStore.query("deliveryExecution", gate.status.execution!.id);
        const snapshot = { topicId: gate.spec.id,
          inputs: inputs.slice(0, 10).map(i => ({ id: i.metadata.name, delivered: !!i.status.assess?.completedAt, description: inputPreview(i, 1000) })) };
        return messageBackground([snapshotMessage({ kind: "topic", uid: gate.metadata.uid }, `Current Gate context; evidence grants no additional authority. Use read tools for missing details.\n${JSON.stringify(snapshot)}\n<me>\n${me}\n</me>`)]);
      } });
    bindInputDelivery(session, current, store.client, log);
    return session;
  };
}
