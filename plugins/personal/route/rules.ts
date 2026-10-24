import { digest } from "../chief-model.ts";
import { CONVERSATION_TYPE, initialConversationName, type ConversationSpec, type ConversationStatus } from "../conversation/model.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { deliver, routed, type RoutingContext, type RoutingInput } from "./delivery.ts";
import type { Destination } from "./model.ts";

/** @spec Topic affinity and original-input receipts route directly; Default is never an unconditional copy.
 * @spec Without any live non-Default candidate, fallback is deterministic; Channel topic creation takes precedence.
 * @link docs/personal/route.md
 */
export async function routeByRules(context: RoutingContext, original: RoutingInput): Promise<boolean> {
  const input = (await context.resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, ...original.metadata }))!;
  if (routed(input)) return true;
  const conversations = (await context.resources.list<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE)).filter(c => !c.metadata.deletionTimestamp);
  const destinations = new Map<string, Destination>();
  for (const c of conversations) if (input.spec.sessionId && c.spec.id === input.spec.sessionId) destinations.set(c.metadata.uid, c.metadata);
  const originalId = input.spec.observation?.originalInputId;
  if (typeof originalId === "string" && originalId !== input.metadata.name) {
    const preceding = await context.resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: originalId });
    for (const c of conversations) if (preceding?.status.route?.result?.conversations.some(ref => ref.uid === c.metadata.uid)) destinations.set(c.metadata.uid, c.metadata);
  }
  // An undecided predecessor is evidence, not a dependency that can block this Input forever.
  if (!destinations.size && input.spec.origin === "channel" && input.spec.sessionId) {
    const sessionId = input.spec.sessionId;
    const name = digest(sessionId);
    let c = await context.resources.get<ConversationSpec, ConversationStatus>({ ...CONVERSATION_TYPE, namespace: "v1", name });
    if (!c) {
      try { c = await context.resources.create<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE, { name,
        spec: { id: sessionId, name: initialConversationName(input.spec.text), ...(input.spec.source ? { address: input.spec.source } : {}) }, status: { receipts: [], summary: "", recent: [] } }); }
      catch (error) {
        if (!String(error).includes("resource already exists")) throw error;
        c = await context.resources.get<ConversationSpec, ConversationStatus>({ ...CONVERSATION_TYPE, namespace: "v1", name });
      }
    }
    if (!c || c.metadata.deletionTimestamp || c.spec.id !== sessionId) throw new Error(`Channel Conversation unavailable: ${name}`);
    destinations.set(c.metadata.uid, c.metadata);
  }
  if (!destinations.size) {
    if (conversations.some(c => !c.spec.default)) return false;
    await deliver(context, input, [await defaultDestination(context)], "No non-Default Conversation candidates");
    return true;
  }
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
    : await context.resources.create<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE, { name, spec: { id, name: "Default", default: true }, status: { receipts: [], summary: "", recent: [] } });
  context.logger.info("Route established Default Conversation", { attributes: { conversationId: c.spec.id, uid: c.metadata.uid } });
  return { name: c.metadata.name, uid: c.metadata.uid };
}
