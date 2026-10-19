import { randomUUID } from "node:crypto";
import type { InputSpec, InputStatus, ResourceClient } from "@compforge/aide-plugin";
import { InputStore } from "../../src/host/input/store.ts";
import { PluginResourceStore } from "../../src/host/plugin/resource.ts";
import type { ResourceClientChange } from "../../src/host/plugin/resource-client.ts";
import { CONVERSATION_TYPE, type Conversation, type ConversationResource, type ConversationInput, type ProcessingStatus, type ConversationSpec, type ConversationStatus } from "./conversation-model.ts";
import type { Message } from "./model.ts";
import { digest } from "./chief-model.ts";
export const conversationKey = digest;

/** @spec Conversation is a Personal Resource. Input facts are shared; consumption and replies belong to each Conversation. */
export class ConversationStore {
  private readonly listeners = new Set<(conversation: Conversation) => void>();
  constructor(readonly sessionId: string, readonly resources: PluginResourceStore, private readonly client: ResourceClient, readonly inputStore: InputStore) {}
  changed(change: ResourceClientChange): void {
    if (change.resource.kind !== CONVERSATION_TYPE.kind || change.kind === "deleted") return;
    const c = this.project(change.resource as ConversationResource);
    for (const listener of this.listeners) listener(c);
  }
  subscribe(listener: (conversation: Conversation) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  resource(id: string): ConversationResource | undefined { return this.resources.find(CONVERSATION_TYPE, conversationKey(id)); }
  list(): Conversation[] { return this.resources.list<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE).map((r) => this.project(r as ConversationResource)); }
  get(id: string): Conversation | undefined { const r = this.resource(id); return r && this.project(r); }
  async ensure(id = this.sessionId): Promise<ConversationResource> {
    const previous = this.resource(id); if (previous) return previous;
    return this.client.create(CONVERSATION_TYPE, { name: conversationKey(id), spec: { id, sessionId: this.sessionId, inputIds: [] }, status: { processing: {}, messages: [], receipts: [] } });
  }
  inputs(conversationId?: string): ConversationInput[] {
    return this.resources.list<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE).filter((r) => !conversationId || (r.spec as { id: string }).id === conversationId).flatMap((raw) => {
      const c = raw as ConversationResource;
      return c.spec.inputIds.map((id) => {
        const input = this.inputStore.get(id); if (!input) throw new Error(`Conversation references missing Input: ${id}`);
        return { ...input, conversationId: c.spec.id, metadata: { ...input.metadata, resourceVersion: c.metadata.resourceVersion }, status: c.status.processing[id] ?? {} };
      });
    });
  }
  input(id: string, conversationId?: string): ConversationInput | undefined {
    const inputs = this.inputs(conversationId).filter((i) => i.metadata.name === id);
    if (inputs.length > 1) throw new Error("Specify Conversation when reading shared Input processing");
    return inputs[0];
  }
  async submit(id: string, spec: InputSpec): Promise<ReturnType<InputStore["submit"]>> {
    return this.inputStore.submit(this.sessionId, id, spec);
  }
  async update(input: ConversationInput, patch: Partial<ProcessingStatus>): Promise<ConversationInput> {
    const c = this.resource(input.conversationId);
    if (!c || c.metadata.resourceVersion !== input.metadata.resourceVersion) throw new Error("Conversation resource version conflict; read it again");
    const previous = c.status.processing[input.metadata.name] ?? {};
    const next = { ...previous, ...patch };
    if (["done", "failed"].includes(previous.phase ?? "") && !["done", "failed"].includes(next.phase ?? "")) throw new Error("Completed input cannot be replayed");
    if (next.phase === "running" && Object.entries(c.status.processing).some(([id, s]) => id !== input.metadata.name && ["running", "waiting"].includes(s.phase ?? ""))) throw new Error("Conversation already has an active input");
    const messages = mergeMessages(c.spec.id, c.status.messages, patch.messages ?? []);
    await this.client.patchStatus(c, { processing: { ...c.status.processing, [input.metadata.name]: next }, messages });
    return this.input(input.metadata.name, c.spec.id)!;
  }
  async archive(id: string, messages: Message[], receipts: Array<{ key: string; responseId: string }> = []): Promise<void> {
    const c = await this.ensure(id);
    await this.client.patchStatus(c, { messages: mergeMessages(id, c.status.messages, messages),
      receipts: [...new Map([...c.status.receipts, ...receipts].map((r) => [r.key, r])).values()] });
  }
  response(key: string): Message | undefined {
    for (const raw of this.resources.list<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE)) {
      const c = raw as ConversationResource; const receipt = c.status.receipts.find((r) => r.key === key);
      if (receipt) return c.status.messages.find((m) => m.id === receipt.responseId);
    }
  }
  async say(conversationId: string, inputId: string | undefined, text: string): Promise<{ messageId: string }> {
    const message: Message = { id: randomUUID(), conversationId, role: "aide", text, workId: null, at: new Date().toISOString() };
    if (inputId) {
      const input = this.input(inputId, conversationId); if (!input) throw new Error("say Input is not attached to this Conversation");
      await this.update(input, { messages: [...input.status.messages ?? [], message] });
    } else await this.archive(conversationId, [message]);
    return { messageId: message.id };
  }
  private project(r: ConversationResource): Conversation {
    return { ...r.spec, revision: Number(r.metadata.resourceVersion), createdAt: r.metadata.creationTimestamp,
      pendingInputIds: r.spec.inputIds.filter((id) => !r.status.processing[id]?.phase), messages: r.status.messages };
  }
}
function mergeMessages(id: string, previous: Message[], incoming: Message[]): Message[] {
  const messages = [...previous];
  for (const message of incoming) {
    if (message.conversationId !== id) throw new Error("Message belongs to another conversation");
    const existing = messages.find((m) => m.id === message.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(message)) throw new Error("Message identity conflict");
    if (!existing) messages.push(message);
  }
  return messages;
}
