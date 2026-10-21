import { conversationPolicy } from "./config.ts";
import type { InputSpec, InputStatus, Resource, ResourceClient } from "@compforge/aide-plugin";
import { INPUT_TYPE } from "../chief-model.ts";
import { CONVERSATION_TYPE, initialConversationName, type ConversationSpec, type ConversationStatus, type ConversationResource } from "./model.ts";

/**
 * @spec An Input already attached to this Conversation is a no-op, preserving its consumption and messages.
 * @spec Retry version conflicts against the same UID so concurrent appends cannot lose Inputs or reset processing.
 * @case tests/input-routing.test.ts
 */
export async function appendConversationInput(resources: ResourceClient,
  target: { sessionId: string; name: string; uid: string }, input: Readonly<Resource<InputSpec, InputStatus>>, maxPending = conversationPolicy().maxPending): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    const c = await resources.get<ConversationSpec, ConversationStatus>({ ...CONVERSATION_TYPE, ...target, namespace: "v1" });
    if (!c || c.metadata.deletionTimestamp) throw new Error(`Routing destination no longer exists: ${target.sessionId}/${target.name}`);
    const fact = await resources.get<InputSpec, InputStatus>({ ...input, ...input.metadata });
    if (!fact) throw new Error("Input expired before append");
    if (c.spec.inputIds.includes(input.metadata.name) || fact.status.deliveries?.includes(c.metadata.uid)) return false;
    assertInputCapacity(c, input.spec, maxPending);
    const status = input.spec.replyTo ? { ...c.status,
      processing: { ...c.status.processing, [input.metadata.name]: { phase: "done" as const } },
    } : c.status;
    const first = c.spec.inputIds[0] ? await resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "aide-system", name: c.spec.inputIds[0] }) : input;
    try {
      await resources.replace(c, { ...c.spec, name: c.spec.name || initialConversationName(first?.spec.text ?? input.spec.text),
        inputIds: [...c.spec.inputIds, input.metadata.name] }, status);
      return true;
    } catch (error) {
      if (attempt >= 4 || !(error instanceof Error) || !error.message.includes("version conflict")) throw error;
    }
  }
}

/** @spec One reserved immediate slot keeps a full deferred queue recoverable; total pending stays <= maxPending + 1. */
export function assertInputCapacity(c: Readonly<ConversationResource>, input: InputSpec, maxPending: number): void {
  const immediate = (input.attention ?? (input.origin === "channel" ? "immediate" : "deferred")) === "immediate";
  const limit = maxPending + (immediate ? 1 : 0);
  const pending = c.spec.inputIds.filter((id) => !c.status.processing[id]?.phase).length;
  if (!input.replyTo && pending >= limit) throw new Error(`Conversation pending input capacity exhausted: ${c.spec.id} (${pending}/${limit})`);
}
