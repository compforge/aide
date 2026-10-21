import { updateConversation } from "./state.ts";
import { randomUUID } from "node:crypto";
import type { InputSpec, InputStatus, ResourceClient } from "@compforge/aide-plugin";
import { InputStore } from "../../../src/host/input/store.ts";
import { PluginResourceStore } from "../../../src/host/plugin/resource/store.ts";
import type { ResourceClientChange } from "../../../src/host/plugin/resource/client.ts";
import { CONVERSATION_TYPE, initialConversationName, type Conversation, type ConversationResource, type ConversationInput, type ConversationRun, type ConversationSpec, type ConversationStatus } from "./model.ts";
import type { Message } from "../model.ts";
import { digest } from "../chief-model.ts";
import { conversationTrigger, nextTriggerAt } from "./trigger.ts";
export const conversationKey = digest;

/** @spec Conversation is a Personal Resource. Input facts are shared; consumption and replies belong to each Conversation. */
export class ConversationStore {
  private readonly listeners = new Set<(conversation: Conversation) => void>();
  constructor(readonly sessionId: string, readonly resources: PluginResourceStore, private readonly client: ResourceClient, readonly inputStore: InputStore) {
    resources.storage.register(resources.scope, { resourceType: CONVERSATION_TYPE, releasedAt: () => undefined,
      references: (r) => { const s = r.status as ConversationStatus; return [...new Set([...s.pendingInputIds, ...s.batch?.inputIds ?? []])].map((id) => `input:${id}`); } });
  }
  changed(change: ResourceClientChange): void {
    if (change.resource.kind !== CONVERSATION_TYPE.kind || change.kind === "deleted") return;
    const c = this.project(change.resource as ConversationResource);
    for (const listener of this.listeners) listener(c);
  }
  subscribe(listener: (conversation: Conversation) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  resource(id: string): ConversationResource | undefined {
    const resource = this.resources.find<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE, conversationKey(id));
    return resource?.metadata.deletionTimestamp ? undefined : resource;
  }
  list(): Conversation[] { return this.resources.list<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE).filter((r) => !r.metadata.deletionTimestamp).map((r) => this.project(r as ConversationResource)); }
  get(id: string): Conversation | undefined { const r = this.resource(id); return r && this.project(r); }
  async ensure(id = this.sessionId): Promise<ConversationResource> {
    const previous = this.resources.find<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE, conversationKey(id));
    if (previous?.metadata.deletionTimestamp) throw new Error("Conversation is being deleted; retry after deletion completes");
    if (previous) return previous;
    return this.client.create(CONVERSATION_TYPE, { name: conversationKey(id), spec: { id, sessionId: this.sessionId, trigger: conversationTrigger() }, status: { pendingInputIds: [], messages: [], receipts: [] } });
  }
  inputs(conversationId?: string): ConversationInput[] {
    return this.list().filter((c) => !conversationId || c.id === conversationId).flatMap((view) => {
      const c = this.resource(view.id)!;
      const ids = new Set([...c.status.pendingInputIds, ...c.status.batch?.inputIds ?? []]);
      // Historical cards use resource-owned receipts; Conversation never accumulates an unbounded ID index.
      return this.inputStore.list().filter((i) => ids.has(i.metadata.name) || i.status.deliveries?.includes(c.metadata.uid)).map((input) => {
        const batch = c.status.batch?.inputIds.includes(input.metadata.name) ? c.status.batch : undefined;
        return { ...input, conversationId: c.spec.id, consumption: batch
          ? { phase: batch.phase, batchId: batch.executionId ?? batch.id, executionId: batch.executionId, quietReason: batch.quietReason }
          : { phase: c.status.pendingInputIds.includes(input.metadata.name) ? undefined : "done" as const } };
      });
    });
  }
  input(id: string, conversationId?: string): ConversationInput | undefined {
    const inputs = this.inputs(conversationId).filter((i) => i.metadata.name === id);
    if (inputs.length > 1) throw new Error("Specify Conversation when reading shared Input processing");
    return inputs[0];
  }
  async submit(id: string, spec: InputSpec): Promise<ReturnType<InputStore["submit"]>> { return this.inputStore.submit(this.sessionId, id, spec); }
  runs(conversationId?: string): ConversationRun[] {
    const runs: ConversationRun[] = this.inputs(conversationId).map((input) => ({ id: input.metadata.name, conversationId: input.conversationId, input, status: input.consumption }));
    for (const c of this.list().filter((c) => !conversationId || c.id === conversationId)) {
      const batch = this.resource(c.id)!.status.batch;
      if (batch) runs.push({ id: batch.executionId ?? batch.id, conversationId: c.id, status: { phase: batch.phase, executionId: batch.executionId, quietReason: batch.quietReason, messages: batch.messages } });
    }
    return runs;
  }
  /** Only the application-wide default selection operation calls this; keep concurrent controller updates intact. */
  async setDefault(id: string, enabled: boolean): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const c = this.resource(id);
      if (!c || c.metadata.deletionTimestamp) throw new Error("Conversation does not exist");
      if (Boolean(c.spec.default) === enabled) return;
      try {
        await this.client.replace(c, { ...c.spec, default: enabled }, c.status);
        return;
      } catch (error) {
        if (attempt >= 4 || !/version|conflict/i.test(String(error))) throw error;
      }
    }
  }
  async setTriggerEnabled(id: string, enabled: boolean): Promise<import("./trigger.ts").ConversationTrigger> {
    const c = this.resource(id); if (!c) throw new Error("Conversation does not exist");
    const trigger = conversationTrigger(c.spec.trigger);
    if (trigger.enabled === enabled) return trigger;
    trigger.enabled = enabled;
    await this.client.replace(c, { ...c.spec, trigger }, { ...c.status, nextTriggerAt: enabled ? nextTriggerAt(trigger) : null });
    return trigger;
  }
  async archive(id: string, messages: Message[], receipts: Array<{ key: string; responseId: string }> = []): Promise<void> {
    const c = await this.ensure(id);
    await updateConversation(this.client, c, (current) => {
      const merged = mergeMessages(id, current.status.messages, messages);
      return { messages: merged, receipts: [...new Map([...current.status.receipts, ...receipts].map((r) => [r.key, r])).values()]
        .filter((r) => merged.some((m) => m.id === r.responseId)) };
    });
  }
  async delivered(conversationId: string, messageId: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const c = this.resource(conversationId);
      if (!c || !c.status.messages.some((m) => m.id === messageId && !m.deliveredAt)) return;
      try {
        await this.client.patchStatus(c, { messages: c.status.messages.map((m) => m.id === messageId ? { ...m, deliveredAt: new Date().toISOString() } : m) });
        return;
      } catch (error) { if (attempt >= 4 || !/version conflict/.test(String(error))) throw error; }
    }
  }
  response(key: string): Message | undefined {
    for (const raw of this.resources.list<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE)) {
      const c = raw as ConversationResource; const receipt = c.status.receipts.find((r) => r.key === key);
      if (receipt) return c.status.messages.find((m) => m.id === receipt.responseId);
    }
  }
  async say(conversationId: string, inputId: string | undefined, text: string, executionId?: string): Promise<{ messageId: string }> {
    const message: Message = { id: randomUUID(), conversationId, role: "aide", text, workId: null, ...(executionId ? { executionId } : {}), at: new Date().toISOString() };
    const c = await this.ensure(conversationId);
    await updateConversation(this.client, c, (current) => {
      const batch = current.status.batch;
      if (executionId && batch?.executionId === executionId) return {
        messages: mergeMessages(conversationId, current.status.messages, [message]),
        batch: { ...batch, communicated: true, messages: [...batch.messages, message] },
      };
      if (inputId && !this.input(inputId, conversationId)) throw new Error("say Input is not attached to this Conversation");
      return { messages: mergeMessages(conversationId, current.status.messages, [message]) };
    });
    return { messageId: message.id };
  }
  private project(r: ConversationResource): Conversation {
    return { ...r.spec, name: r.spec.name || initialConversationName(this.inputStore.get(r.status.pendingInputIds[0] ?? "")?.spec.text ?? ""), revision: Number(r.metadata.resourceVersion), createdAt: r.metadata.creationTimestamp,
      pendingInputIds: r.status.pendingInputIds, messages: r.status.messages };
  }
}
function mergeMessages(id: string, previous: Message[], incoming: Message[]): Message[] {
  const messages = [...previous];
  for (const message of incoming) {
    if (message.conversationId !== id) throw new Error("Message belongs to another conversation");
    const existing = messages.find((m) => m.id === message.id);
    if (existing && JSON.stringify({ ...existing, deliveredAt: undefined }) !== JSON.stringify({ ...message, deliveredAt: undefined })) throw new Error("Message identity conflict");
    if (!existing) messages.push(message);
  }
  return messages.filter((m, index) => index >= messages.length - 100 || (id.startsWith("lark:") && !m.deliveredAt));
}
