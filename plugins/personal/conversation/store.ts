import { resourceRef } from "../input/state.ts";
import { parseAddress, sameAddress } from "../../../src/address.ts";
import { randomUUID } from "node:crypto";
import type { ResourceClient, Address } from "@compforge/aide-plugin";
import type { InputSpec } from "../input/model.ts";
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
  /** @spec The creating Channel supplies its address and first-input name before asynchronous routing; later attachment cannot replace either. */
  async ensure(id: string, address?: Address, name?: string): Promise<ConversationResource> {
    const previous = this.resources.find<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE, conversationKey(id));
    if (previous?.metadata.deletionTimestamp) throw new Error("Conversation is being deleted; retry after deletion completes");
    if (previous) return previous;
    return this.client.create(CONVERSATION_TYPE, { name: conversationKey(id), spec: { id, ...(name ? { name } : {}), ...(address ? { address: parseAddress(address) } : {}), trigger: conversationTrigger() }, status: { receipts: [], summary: "", recent: [] } });
  }
  inputs(conversationId?: string): ConversationInput[] {
    return this.list().filter((c) => !conversationId || c.id === conversationId).flatMap((view) => {
      const c = this.resource(view.id)!;
      return this.inputStore.query("assess", c.metadata.uid).map((input) => {
        const receipt = input.status.assess![c.metadata.uid]!;
        return { ...input, conversationId: c.spec.id, consumption: {
          phase: receipt.completedAt ? "done" as const : receipt.lastError ? "failed" as const : receipt.executionId ? "running" as const : undefined,
          executionId: receipt.executionId, summary: receipt.result?.summary, error: receipt.completedAt ? undefined : receipt.lastError } };
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
      const execution = this.resource(c.id)!.status.execution;
      if (execution) runs.push({ id: execution.id, conversationId: c.id, status: { phase: "running", executionId: execution.id } });
    }
    return runs;
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
    options: Omit<SayInput, "text"> = {}, owner?: import("@compforge/aide-plugin").Resource<unknown, { execution?: { id: string } | null }>): Promise<{ outputId: string }> {
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
      const candidates = (inputIds.length ? inputIds : this.pending(initial.metadata.uid).map(i => i.metadata.name)).map(attached)
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
      if (owner) {
        const latest = await this.client.get<unknown, { execution?: { id: string } | null }>(resourceRef(owner));
        if (!latest || latest.metadata.deletionTimestamp) throw new Error("Output owner is no longer active");
        owner = latest;
      }
      if (executionId && (owner ? owner.status.execution?.id : c.status.execution?.id) !== executionId) throw new Error("Output execution is no longer active");
      const draft: OutputDraft = { id, conversationId, text, workId: null };
      const association = { ...(owner ? { producer: resourceRef(owner) } : {}), target, ...(receivers !== undefined ? { receivers } : {}), ...(executionId ? { executionId } : {}), ...(inputIds.length ? { inputIds } : {}) };
      try {
        await this.client.commit([
          { operation: "patchStatus", resource: c, patch: {} },
          ...(owner ? [{ operation: "patchStatus" as const, resource: owner, patch: {} }] : []),
          outputWrite(c, draft, association),
        ]);
        return { outputId: id };
      } catch (error) { if (attempt >= 8 || !/version conflict/.test(String(error))) throw error; }
    }
  }
  pending(uid: string) { return this.inputStore.query("assessPending", uid); }
  private project(r: ConversationResource): Conversation {
    const pending = this.pending(r.metadata.uid);
    return { ...r.spec, name: r.spec.name || initialConversationName(pending[0]?.spec.text ?? ""), revision: Number(r.metadata.resourceVersion), createdAt: r.metadata.creationTimestamp,
      pendingInputIds: pending.map(i => i.metadata.name), outputs: this.outputStore.list({ conversationUid: r.metadata.uid }).map(outputView) };
  }
}
