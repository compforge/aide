import { conversationPolicy } from "./config.ts";
import type { InputSpec, InputStatus, Resource, ResourceClient } from "@compforge/aide-plugin";
import { CONVERSATION_TYPE, initialConversationName, type ConversationSpec, type ConversationStatus, type ConversationResource } from "./model.ts";

/** @spec CAS append preserves concurrent changes. Input-owned delivery receipts outlive dequeue and Batch replacement.
 * @case tests/input-routing.test.ts
 */
export async function appendConversationInput(resources: ResourceClient,
  target: { sessionId: string; name: string; uid: string }, input: Readonly<Resource<InputSpec, InputStatus>>, maxPending = conversationPolicy().maxPending): Promise<boolean> {
  let appended = false;
  for (let attempt = 0; ; attempt++) {
    const c = await resources.get<ConversationSpec, ConversationStatus>({ ...CONVERSATION_TYPE, ...target, namespace: "v1" });
    if (!c || c.metadata.deletionTimestamp) throw new Error(`Routing destination no longer exists: ${target.sessionId}/${target.name}`);
    const fact = await resources.get<InputSpec, InputStatus>({ ...input, ...input.metadata });
    if (!fact) throw new Error("Input expired before append");
    if (fact.status.deliveries?.includes(c.metadata.uid)) return appended;
    try {
      if (!input.spec.replyTo && !c.status.pendingInputIds.includes(input.metadata.name)) {
        assertInputCapacity(c, input.spec, maxPending);
        await resources.replace(c, { ...c.spec, name: c.spec.name || initialConversationName(input.spec.text) }, {
          ...c.status, pendingInputIds: [...c.status.pendingInputIds, input.metadata.name],
        });
        appended = true;
      }
      await resources.patchStatus(fact, { deliveries: [...fact.status.deliveries ?? [], c.metadata.uid] });
      return appended;
    } catch (error) {
      if (attempt >= 8 || !/version conflict/.test(String(error))) throw error;
    }
  }
}

/** @spec One immediate slot remains available at capacity. Interaction replies bypass the ordinary inbox. */
export function assertInputCapacity(c: Readonly<ConversationResource>, input: InputSpec, maxPending: number): void {
  const immediate = (input.attention ?? (input.origin === "channel" ? "immediate" : "deferred")) === "immediate";
  const limit = maxPending + (immediate ? 1 : 0);
  if (!input.replyTo && c.status.pendingInputIds.length >= limit) throw new Error(`Conversation pending input capacity exhausted: ${c.spec.id} (${c.status.pendingInputIds.length}/${limit})`);
}
