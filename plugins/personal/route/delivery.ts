import type { PluginContext, Resource, ResourceCommit } from "@compforge/aide-plugin";
import { CONVERSATION_TYPE, initialConversationName, type ConversationSpec, type ConversationStatus } from "../conversation/model.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { resourceRef } from "../input/state.ts";
import type { Destination } from "./model.ts";
export type RoutingContext = Pick<PluginContext, "resources"> & { logger: Pick<PluginContext["logger"], "info"> };
export type RoutingInput = Readonly<Resource<InputSpec, InputStatus>>;
export const routed = (input: RoutingInput) => !!input.status.route?.completedAt;
/** @spec A routing decision and all assessment assignments are one atomic fact. Repeated decisions never reopen a consumer. */
export async function deliver(context: RoutingContext, original: RoutingInput, destinations: Destination[], reason: string) {
  for (let n = 0; ; n++) {
    const input = await context.resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, ...original.metadata });
    if (!input) throw new Error("Input no longer exists");
    if (routed(input)) return;
    if (!destinations.length) throw new Error("Route needs a destination or Default");
    const conversations = await Promise.all([...new Map(destinations.map(d => [d.uid, d])).values()].map(async d => {
      const c = await context.resources.get<ConversationSpec, ConversationStatus>({ ...CONVERSATION_TYPE, namespace: "v1", ...d });
      if (!c || c.metadata.deletionTimestamp) throw new Error(`Conversation no longer exists: ${d.uid}`);
      return c;
    }));
    const at = new Date().toISOString();
    const assess = { ...input.status.assess };
    for (const c of conversations) assess[c.metadata.uid] ??= { resource: resourceRef(c), assignedAt: at };
    try {
      await context.resources.commit([
        ...conversations.map(c => (c.spec.name ? { operation: "patchStatus", resource: c, patch: {} }
          : { operation: "replace", resource: c, spec: { ...c.spec, name: initialConversationName(input.spec.text) }, status: c.status }) as ResourceCommit),
        { operation: "patchStatus", resource: input, patch: { assess, route: { ...input.status.route, completedAt: at,
          result: { conversations: conversations.map(resourceRef), reason } } } },
      ]);
      context.logger.info("Input routed", { attributes: { inputId: input.metadata.name, conversationUids: conversations.map(c => c.metadata.uid), reason } });
      return;
    } catch (e) { if (n >= 8 || !/version conflict/.test(String(e))) throw e; }
  }
}
