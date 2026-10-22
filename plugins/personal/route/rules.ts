import { digest } from "../chief-model.ts";
import { CONVERSATION_TYPE, initialConversationName, type ConversationSpec, type ConversationStatus } from "../conversation/model.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { deliver, routed, type RoutingContext, type RoutingInput } from "./delivery.ts";
import type { Destination } from "./model.ts";

/** @spec Topic affinity and original-input receipts route directly; Default is never an unconditional copy. */
export async function routeByRules(context: RoutingContext, original: RoutingInput): Promise<boolean> {
  let input = (await context.resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, ...original.metadata }))!;
  if (routed(input)) return true;
  if (input.status.routing?.destinations) {
    await deliver(context, input, input.status.routing.destinations, input.status.routing.reason);
    return true;
  }
  const conversations = (await context.resources.list<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE)).filter(c => !c.metadata.deletionTimestamp);
  const destinations = new Map<string, Destination>();
  for (const c of conversations) if (input.spec.sessionId && c.spec.id === input.spec.sessionId) destinations.set(c.metadata.uid, c.metadata);
  const originalId = input.spec.observation?.originalInputId;
  if (typeof originalId === "string" && originalId !== input.metadata.name) {
    const preceding = await context.resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: originalId });
    if (preceding && !routed(preceding)) return false; // Revisit after the predecessor's durable decision.
    for (const c of conversations) if (preceding?.status.deliveries?.includes(c.metadata.uid)) destinations.set(c.metadata.uid, c.metadata);
  }
  // A Channel's explicit topic may establish its conversation. Source topic hints alone never create one.
  // Preserve a creation planned by the previous router across upgrades.
  if (input.status.routing?.creation || (!destinations.size && input.spec.origin === "channel" && input.spec.sessionId)) {
    if (!input.status.routing?.creation) {
      const sessionId = input.spec.sessionId!;
      input = await context.resources.patchStatus(input, { routing: { phase: "running", reason: "Channel topic", creation: { sessionId, name: digest(sessionId) } } });
    }
    const planned = input.status.routing!.creation!;
    let c = await context.resources.get<ConversationSpec, ConversationStatus>({ ...CONVERSATION_TYPE, namespace: "v1", name: planned.name, ...(planned.uid ? { uid: planned.uid } : {}) });
    if (!c && !planned.uid) {
      try { c = await context.resources.create<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE, { name: planned.name,
        spec: { id: planned.sessionId, name: initialConversationName(input.spec.text), ...(input.spec.origin === "channel" && input.spec.source ? { address: input.spec.source } : {}) },
        status: { pendingInputIds: [], receipts: [] } }); }
      catch (error) {
        if (!String(error).includes("resource already exists")) throw error;
        c = await context.resources.get<ConversationSpec, ConversationStatus>({ ...CONVERSATION_TYPE, namespace: "v1", name: planned.name });
      }
    }
    if (!c || c.metadata.deletionTimestamp || c.spec.id !== planned.sessionId) throw new Error(`Planned Conversation no longer exists: ${planned.name}`);
    input = await context.resources.patchStatus(input, { routing: { ...input.status.routing!, creation: { ...planned, uid: c.metadata.uid } } });
    destinations.set(c.metadata.uid, c.metadata);
  }
  if (!destinations.size) return false;
  await deliver(context, input, [...destinations.values()].map(({ name, uid }) => ({ name, uid })), "Deterministic topic or original Input");
  return true;
}

/** @spec Unmatched inputs always have a durable fallback; an observed address is never adopted as its reply address. */
export async function defaultDestination(context: RoutingContext): Promise<Destination> {
  const all = await context.resources.list<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE);
  const current = all.find(c => c.spec.default && !c.metadata.deletionTimestamp);
  if (current) return { name: current.metadata.name, uid: current.metadata.uid };
  const id = "default";
  const name = digest(id);
  const existing = all.find(c => c.metadata.name === name);
  if (existing?.metadata.deletionTimestamp) throw new Error("Default Conversation is being deleted");
  const c = existing ? await context.resources.replace(existing, { ...existing.spec, default: true }, existing.status)
    : await context.resources.create<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE, { name, spec: { id, name: "Default", default: true }, status: { pendingInputIds: [], receipts: [] } });
  context.logger.info("Route established Default Conversation", { attributes: { conversationId: c.spec.id, uid: c.metadata.uid } });
  return { name: c.metadata.name, uid: c.metadata.uid };
}
