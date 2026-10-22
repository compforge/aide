import { type Resource, type ResourceClient } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { CONVERSATION_TYPE, initialConversationName, type ConversationSpec, type ConversationStatus } from "./model.ts";

/** @spec CAS append preserves concurrent changes. Input-owned delivery receipts outlive dequeue and Batch replacement.
 * @case tests/input-routing.test.ts
 */
export async function appendConversationInput(resources: ResourceClient,
  target: { sessionId?: string; name: string; uid: string }, input: Readonly<Resource<InputSpec, InputStatus>>): Promise<boolean> {
  let appended = false;
  for (let attempt = 0; ; attempt++) {
    const c = await resources.get<ConversationSpec, ConversationStatus>({ ...CONVERSATION_TYPE, ...target, namespace: "v1" });
    if (!c || c.metadata.deletionTimestamp) throw new Error(`Routing destination no longer exists: ${target.sessionId}/${target.name}`);
    const fact = await resources.get<InputSpec, InputStatus>({ ...input, ...input.metadata });
    if (!fact) throw new Error("Input expired before append");
    if (fact.status.deliveries?.includes(c.metadata.uid)) return appended;
    try {
      if (!c.status.pendingInputIds.includes(input.metadata.name)) {
        await resources.replace(c, { ...c.spec, name: c.spec.name || initialConversationName(input.spec.text) }, {
          ...c.status, pendingInputIds: [...c.status.pendingInputIds, input.metadata.name],
        });
        appended = true;
      }
      await recordInputDelivery(resources, c.metadata.uid, fact.metadata.name);
      return appended;
    } catch (error) {
      if (attempt >= 8 || !/version conflict/.test(String(error))) throw error;
    }
  }
}

/** @spec Receipt persistence precedes dequeue. Both intake and recovery use the same idempotent operation. */
export async function recordInputDelivery(resources: ResourceClient, conversationUid: string, inputId: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const input = await resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: inputId });
    if (!input) throw new Error(`Input missing before delivery acknowledgement: ${inputId}`);
    if (input.status.deliveries?.includes(conversationUid)) return;
    try {
      await resources.patchStatus(input, { deliveries: [...input.status.deliveries ?? [], conversationUid] });
      return;
    } catch (error) {
      if (attempt >= 8 || !/version conflict/.test(String(error))) throw error;
    }
  }
}
