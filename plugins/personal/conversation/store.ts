import { parseAddress, sameAddress } from "../../../src/address.ts";
import { randomUUID } from "node:crypto";
import type { ResourceClient, Address } from "@compforge/aide-plugin";
import type { InputSpec, InputStatus } from "../input/model.ts";
import type { SayInput } from "../output/model.ts";
import { InputStore } from "../input/store.ts";
import { PluginResourceStore } from "../../../src/host/plugin/resource/store.ts";
import type { ResourceClientChange } from "../../../src/host/plugin/resource/client.ts";
import { CONVERSATION_TYPE, initialConversationName, type Conversation, type ConversationResource, type ConversationInput, type ConversationRun, type ConversationSpec, type ConversationStatus } from "./model.ts";
import { outputView, type OutputDraft, type OutputView } from "../../../src/output.ts";
import { OutputStore } from "../output/store.ts";
import { outputWrite } from "../output.ts";
import { digest } from "../chief-model.ts";
import { conversationTrigger, nextTriggerAt } from "./trigger.ts";
export const conversationKey = digest;

/** @spec Conversation is a Personal Resource. Input facts are shared; consumption and replies belong to each Conversation. */
export class ConversationStore {
  private readonly listeners = new Set<(conversation: Conversation) => void>();
  constructor(readonly resources: PluginResourceStore, private readonly client: ResourceClient, readonly inputStore: InputStore, readonly outputStore = new OutputStore(resources.storage.home)) {

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
  /** @spec The creating Channel supplies the initial address; later attachment never fills or replaces it. */
  async ensure(id: string, address?: Address): Promise<ConversationResource> {
    const previous = this.resources.find<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE, conversationKey(id));
    if (previous?.metadata.deletionTimestamp) throw new Error("Conversation is being deleted; retry after deletion completes");
    if (previous) return previous;
    return this.client.create(CONVERSATION_TYPE, { name: conversationKey(id), spec: { id, ...(address ? { address: parseAddress(address) } : {}), trigger: conversationTrigger() }, status: { pendingInputIds: [], receipts: [] } });
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
  async submit(id: string, spec: InputSpec): Promise<ReturnType<InputStore["submit"]>> { return this.inputStore.submit(spec.sessionId ?? "personal", id, spec); }
  runs(conversationId?: string): ConversationRun[] {
    const runs: ConversationRun[] = this.inputs(conversationId).map((input) => ({ id: input.metadata.name, conversationId: input.conversationId, input, status: input.consumption }));
    for (const c of this.list().filter((c) => !conversationId || c.id === conversationId)) {
      const batch = this.resource(c.id)!.status.batch;
      if (batch) runs.push({ id: batch.executionId ?? batch.id, conversationId: c.id, status: { phase: batch.phase, executionId: batch.executionId, quietReason: batch.quietReason, outputs: this.outputs(c.id).filter((o) => batch.outputIds.includes(o.id)) } });
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
  outputs(conversationId?: string): OutputView[] {
    const resources = this.listResources(conversationId);
    return resources.flatMap((c) => this.outputStore.list({ conversationUid: c.metadata.uid }).map(outputView))
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }
  private listResources(id?: string): ConversationResource[] {
    return this.resources.list<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE)
      .filter((c) => !c.metadata.deletionTimestamp && (!id || c.spec.id === id));
  }
  async archive(id: string, outputs: OutputDraft[], receipts: Array<{ key: string; responseId: string }> = []): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const c = await this.ensure(id);
      try {
        await this.client.commit([
          { operation: "patchStatus", resource: c, patch: { receipts: [...new Map([...c.status.receipts, ...receipts].map((r) => [r.key, r])).values()].slice(-100) } },
          ...outputs.map((o) => outputWrite(c, o)),
        ]);
        return;
      } catch (error) { if (attempt >= 8 || !/version conflict/.test(String(error))) throw error; }
    }
  }
  response(key: string): OutputView | undefined {
    for (const c of this.listResources()) {
      const receipt = c.status.receipts.find((r) => r.key === key);
      const output = receipt && this.outputStore.get(receipt.responseId);
      if (output) return outputView(output);
    }
  }
  async say(conversationId: string, inputId: string | undefined, text: string, executionId?: string,
    options: Omit<SayInput, "text"> = {}): Promise<{ outputId: string }> {
    const initial = await this.ensure(conversationId);
    const id = options.idempotencyKey ? digest([initial.metadata.uid, executionId ?? "", options.idempotencyKey]) : randomUUID();
    if (options.respondToInputId && options.target) throw new Error("say must choose respondToInputId or target, not both");
    const inputIds = [...new Set([...(options.inputIds ?? (inputId ? [inputId] : [])), ...(options.respondToInputId ? [options.respondToInputId] : [])])];
    const attached = (id: string) => {
      const input = this.input(id, conversationId);
      if (!input) throw new Error(`say Input is not attached to this Conversation: ${id}`);
      return input;
    };
    for (const id of inputIds) attached(id);
    let target: Address | undefined = options.target && parseAddress(options.target);
    let receivers = options.receivers === undefined ? undefined : [...options.receivers];
    if (options.respondToInputId) {
      const reply = attached(options.respondToInputId).spec;
      target = reply.source;
      // A direct reply identifies its sender; explicit receivers (including []) remain the caller's decision.
      if (receivers === undefined && reply.sender) receivers = [reply.sender];
      if (!target) throw new Error(`Reply Input has no address: ${options.respondToInputId}`);
    }
    if (!target) {
      const candidates = (inputIds.length ? inputIds : initial.status.batch?.inputIds ?? []).map(attached)
        .filter((i) => (i.spec.attention ?? (i.spec.origin === "channel" ? "immediate" : "deferred")) === "immediate");
      if (candidates.length) {
        const first = candidates[0]!.spec.source;
        if (!first || candidates.some((i) => !i.spec.source || !sameAddress(first, i.spec.source))) {
          throw new Error("say requires respondToInputId or target for Inputs with different or missing addresses");
        }
        target = first;
      } else target = initial.spec.address;
    }
    if (!target) throw new Error("say requires an explicit target; this Conversation has no address");
    for (let attempt = 0; ; attempt++) {
      const c = this.resource(conversationId);
      if (!c || c.metadata.uid !== initial.metadata.uid) throw new Error("Output Conversation was replaced");
      const batch = c.status.batch;
      if (executionId && batch && batch.executionId !== executionId) throw new Error("Output Batch was superseded");
      const draft: OutputDraft = { id, conversationId, text, workId: null };
      const association = { target, ...(receivers !== undefined ? { receivers } : {}), ...(executionId ? { executionId } : {}), ...(inputIds.length ? { inputIds } : {}) };
      try {
        await this.client.commit([
          // Pin before inserting a delivered Web Output so collection cannot race Batch handoff.
          ...(batch && executionId ? [{ operation: "patchStatus" as const, resource: c,
            patch: { batch: { ...batch, communicated: true, outputIds: [...new Set([...batch.outputIds, id])] } } }] : []),
          outputWrite(c, draft, association),
        ]);
        return { outputId: id };
      } catch (error) { if (attempt >= 8 || !/version conflict/.test(String(error))) throw error; }
    }
  }
  private project(r: ConversationResource): Conversation {
    return { ...r.spec, name: r.spec.name || initialConversationName(this.inputStore.get(r.status.pendingInputIds[0] ?? "")?.spec.text ?? ""), revision: Number(r.metadata.resourceVersion), createdAt: r.metadata.creationTimestamp,
      pendingInputIds: r.status.pendingInputIds, outputs: this.outputStore.list({ conversationUid: r.metadata.uid }).map(outputView) };
  }
}
