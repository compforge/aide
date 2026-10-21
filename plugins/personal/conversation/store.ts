import { randomUUID } from "node:crypto";
import type { InputSpec, InputStatus, ResourceClient } from "@compforge/aide-plugin";
import { InputStore } from "../../../src/host/input/store.ts";
import { PluginResourceStore } from "../../../src/host/plugin/resource/store.ts";
import type { ResourceClientChange } from "../../../src/host/plugin/resource/client.ts";
import { CONVERSATION_TYPE, initialConversationName, type Conversation, type ConversationResource, type ConversationInput, type ConversationRun, type ProcessingStatus, type ConversationSpec, type ConversationStatus } from "./model.ts";
import type { Message } from "../model.ts";
import { digest } from "../chief-model.ts";
import { conversationTrigger, nextTriggerAt } from "./trigger.ts";
export const conversationKey = digest;

/** @spec Conversation is a Personal Resource. Input facts are shared; consumption and replies belong to each Conversation. */
export class ConversationStore {
  private readonly listeners = new Set<(conversation: Conversation) => void>();
  constructor(readonly sessionId: string, readonly resources: PluginResourceStore, private readonly client: ResourceClient, readonly inputStore: InputStore) {
    resources.storage.register(resources.scope, { resourceType: CONVERSATION_TYPE, releasedAt: () => undefined,
      references: (r) => (r.spec as ConversationSpec).inputIds.map((id) => `input:${id}`) });
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
    return this.client.create(CONVERSATION_TYPE, { name: conversationKey(id), spec: { id, sessionId: this.sessionId, inputIds: [], trigger: conversationTrigger() }, status: { processing: {}, messages: [], receipts: [] } });
  }
  inputs(conversationId?: string): ConversationInput[] {
    return this.resources.list<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE).filter((r) => !r.metadata.deletionTimestamp && (!conversationId || r.spec.id === conversationId)).flatMap((raw) => {
      const c = raw as ConversationResource;
      return c.spec.inputIds.map((id) => {
        const input = this.inputStore.get(id); if (!input) throw new Error(`Conversation references missing Input: ${id}`);
        return { ...input, conversationId: c.spec.id, metadata: { ...input.metadata, resourceVersion: c.metadata.resourceVersion }, status: c.status.processing[id]?.roundId ? { ...c.status.processing[c.status.processing[id]!.roundId!], ...c.status.processing[id] } : c.status.processing[id] ?? {} };
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
  runs(conversationId?: string): ConversationRun[] {
    const inputs = this.inputs(conversationId);
    return this.list().filter((c) => !conversationId || c.id === conversationId).flatMap((c) => {
      const resource = this.resource(c.id)!;
      const runs: ConversationRun[] = inputs.filter((i) => i.conversationId === c.id).map((input) => ({
        id: input.metadata.name, conversationId: c.id, resourceVersion: resource.metadata.resourceVersion, input, status: input.status,
      }));
      for (const [id, status] of Object.entries(resource.status.processing)) {
        if (status.timerAt || status.batchInputIds) runs.push({ id, conversationId: c.id, resourceVersion: resource.metadata.resourceVersion, status });
      }
      return runs;
    });
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
  async update(input: ConversationInput, patch: Partial<ProcessingStatus>): Promise<ConversationInput> {
    await this.updateRun({ id: input.metadata.name, conversationId: input.conversationId,
      resourceVersion: input.metadata.resourceVersion, input, status: input.status }, patch);
    return this.input(input.metadata.name, input.conversationId)!;
  }
  async updateRun(run: ConversationRun, patch: Partial<ProcessingStatus>): Promise<void> {
    const c = this.resource(run.conversationId);
    if (!c || c.metadata.resourceVersion !== run.resourceVersion) throw new Error("Conversation resource version conflict; read it again");
    const previous = c.status.processing[run.id] ?? {};
    const next = { ...previous, ...patch };
    if (["done", "failed"].includes(previous.phase ?? "") && !["done", "failed"].includes(next.phase ?? "")) throw new Error("Completed input cannot be replayed");
    if (next.phase === "running" && Object.entries(c.status.processing).some(([id, s]) => id !== run.id && !s.roundId && ["running", "waiting"].includes(s.phase ?? ""))) throw new Error("Conversation already has an active input");
    const messages = mergeMessages(c.spec.id, c.status.messages, patch.messages ?? []);
    await this.client.patchStatus(c, { processing: { ...c.status.processing, [run.id]: next }, messages });
  }
  async archive(id: string, messages: Message[], receipts: Array<{ key: string; responseId: string }> = []): Promise<void> {
    const c = await this.ensure(id);
    await this.client.patchStatus(c, { messages: mergeMessages(id, c.status.messages, messages),
      receipts: [...new Map([...c.status.receipts, ...receipts].map((r) => [r.key, r])).values()] });
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
    const message: Message = { id: randomUUID(), conversationId, role: "aide", text, workId: null, at: new Date().toISOString() };
    if (inputId) {
      const input = this.input(inputId, conversationId); if (!input) throw new Error("say Input is not attached to this Conversation");
      await this.update(input, { messages: [...input.status.messages ?? [], message] });
    } else {
      const run = executionId && this.runs(conversationId).find((r) => r.status.executionId === executionId && !r.status.roundId);
      if (run) await this.updateRun(run, { messages: [...run.status.messages ?? [], message] });
      else await this.archive(conversationId, [message]);
    }
    return { messageId: message.id };
  }
  private project(r: ConversationResource): Conversation {
    return { ...r.spec, name: r.spec.name || initialConversationName(this.inputStore.get(r.spec.inputIds[0] ?? "")?.spec.text ?? ""), revision: Number(r.metadata.resourceVersion), createdAt: r.metadata.creationTimestamp,
      pendingInputIds: r.spec.inputIds.filter((id) => !r.status.processing[id]?.phase), messages: r.status.messages };
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
  return messages;
}
