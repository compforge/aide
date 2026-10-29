import { commitStatus } from "../status.ts";
import { agentCall } from "../observation/reference.ts";
import { ensureDefaultTopic } from "./default.ts";
import { topicSubtree } from "./tree.ts";
import { resourceRef, belongsToTopic } from "../input/state.ts";
import { parseAddress, sameAddress } from "../../../src/address.ts";
import { randomUUID } from "node:crypto";
import type { ResourceClient, Address } from "@compforge/aide-plugin";
import { InputAttention, inputAttention, type InputSpec } from "../input/model.ts";
import type { SayInput, SayReceipt } from "../output/model.ts";
import { InputStore } from "../input/store.ts";
import { PluginResourceStore } from "../../../src/host/plugin/resource/store.ts";
import type { ResourceClientChange } from "../../../src/host/plugin/resource/client.ts";
import { DEFAULT_TOPIC_ID, TOPIC_TYPE, initialTopicName, type Topic, type TopicResource, type TopicInput, type TopicRun, type TopicSpec, type TopicStatus } from "./model.ts";
import { outputView, type OutputDraft, type OutputView } from "../../../src/output.ts";
import { OutputStore } from "../output/store.ts";
import { outputWrite } from "../output.ts";
import { digest } from "../chief-model.ts";
import { topicReview } from "./review.ts";
export const topicKey = digest;

/** @spec Topic is a Personal Resource. Input assessment is global; Topic routing determines material visibility and each Output records its producer. */
export class TopicStore {
  private readonly listeners = new Set<(topic: Topic) => void>();
  constructor(readonly resources: PluginResourceStore, private readonly client: ResourceClient, readonly inputStore: InputStore, readonly outputStore = new OutputStore(resources.storage.home),
    private readonly resolveContact?: (topicId: string, to?: SayInput["to"], channelId?: string, target?: Address) => Promise<{ target: Address; receivers: import("@compforge/aide-plugin").ResourceRef[] }>) {

  }
  changed(change: ResourceClientChange): void {
    if (change.resource.kind !== TOPIC_TYPE.kind || change.kind === "deleted") return;
    const c = this.project(change.resource as TopicResource);
    for (const listener of this.listeners) listener(c);
  }
  subscribe(listener: (topic: Topic) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  resource(id: string): TopicResource | undefined {
    const resource = this.resources.find<TopicSpec, TopicStatus>(TOPIC_TYPE, topicKey(id));
    return resource?.metadata.deletionTimestamp ? undefined : resource;
  }
  byRef(ref: import("@compforge/aide-plugin").ResourceRef): TopicResource | undefined {
    const topic = this.resources.find<TopicSpec, TopicStatus>(TOPIC_TYPE, ref.name, ref.namespace);
    return topic && topic.metadata.uid === ref.uid && !topic.metadata.deletionTimestamp ? topic : undefined;
  }
  byKey(key: string): TopicResource | undefined {
    return this.resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE, { matchIndex: { name: "topicKey", value: key } })[0];
  }
  list(): Topic[] { return this.resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE).filter((r) => !r.metadata.deletionTimestamp).map((r) => this.project(r as TopicResource)); }
  get(id: string): Topic | undefined { const r = this.resource(id); return r && this.project(r); }
  /** @spec The creating Channel supplies its address and first-input name before asynchronous routing; later attachment cannot replace either. */
  async ensure(id: string, address?: Address, name?: string): Promise<TopicResource> {
    if (id === DEFAULT_TOPIC_ID) return ensureDefaultTopic(this.client);
    const previous = this.resources.find<TopicSpec, TopicStatus>(TOPIC_TYPE, topicKey(id));
    if (previous?.metadata.deletionTimestamp) throw new Error("Topic is being deleted; retry after deletion completes");
    if (previous) return previous;
    return this.client.create(TOPIC_TYPE, { name: topicKey(id), spec: { id, ...(name ? { name } : {}), ...(address ? { address: parseAddress(address) } : {}), review: topicReview() }, status: { receipts: [], summary: "" } });
  }
  /**
   * @spec Presentation follows the completing execution when recorded; the original admission stays on Input for recovery.
   * @link docs/personal/input.md#归属与-chief-通知
   * @case tests/input-assessment.test.ts
   */
  inputs(topicId?: string): TopicInput[] {
    const selected = topicId ? this.resource(topicId) : undefined;
    if (topicId && !selected) return [];
    const all = selected ? this.scope(selected.metadata.uid) : this.listResources();
    const members = new Set(all.map(t => t.metadata.uid));
    const outputExecutions = new Map(this.outputStore.list().flatMap(o => o.spec.executionId
      ? Object.values(o.spec.inputUids ?? {}).map(uid => [uid, o.spec.executionId!] as const) : []));
    const inputs = selected
      ? [...new Map(all.flatMap(t => this.inputStore.query("topic", t.metadata.uid)).map(i => [i.metadata.uid, i])).values()]
      : this.inputStore.list();
    return inputs.flatMap(input => {
      const binding = input.status.topic && members.has(input.status.topic.uid) ? input.status.topic : undefined;
      if (!binding) return [];
      const topic = selected ?? all.find(t => t.metadata.uid === binding?.uid);
      if (!topic) return [];
      const receipt = input.status.assess;
      return [{ ...input, topicId: topic.spec.id, consumption: {
        phase: receipt?.completedAt ? "done" as const : undefined,
        executionId: receipt?.completedBy?.executionId ?? receipt?.executionId ?? outputExecutions.get(input.metadata.uid), summary: receipt?.result?.summary,
      } }];
    });
  }
  input(id: string, topicId?: string): TopicInput | undefined {
    const inputs = this.inputs(topicId).filter((i) => i.metadata.name === id);
    if (inputs.length > 1) throw new Error("Specify Topic when reading shared Input processing");
    return inputs[0];
  }
  async submit(id: string, spec: InputSpec): Promise<ReturnType<InputStore["submit"]>> { return this.inputStore.submit(spec.topicKey ?? spec.topicId ?? "personal", id, spec); }
  runs(topicId?: string): TopicRun[] {
    const runs: TopicRun[] = this.inputs(topicId).map((input) => ({ id: input.metadata.name, topicId: input.topicId, input, status: input.consumption }));
    for (const c of this.list().filter((c) => !topicId || c.id === topicId)) {
      const execution = this.resource(c.id)!.status.execution;
      if (execution) runs.push({ id: execution.id, topicId: c.id, status: { phase: "running", executionId: execution.id } });
    }
    return runs;
  }
  async setReviewEnabled(id: string, enabled: boolean): Promise<import("./review.ts").TopicReview> {
    const c = this.resource(id); if (!c) throw new Error("Topic does not exist");
    const review = topicReview(c.spec.review);
    if (review.enabled === enabled) return review;
    review.enabled = enabled;
    await this.client.replace(c, { ...c.spec, review }, { ...c.status, reviewCheckedAt: null, idleReviewCount: 0, idleReviewReset: null,
      ...(enabled ? { idleSince: new Date().toISOString() } : {}) });
    return review;
  }
  outputs(topicId?: string): OutputView[] {
    const selected = topicId ? this.resource(topicId) : undefined;
    const resources = topicId ? selected ? this.scope(selected.metadata.uid) : [] : this.listResources();
    return resources.flatMap((c) => this.outputStore.list({ topicUid: c.metadata.uid }).map(outputView))
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }
  private listResources(id?: string): TopicResource[] {
    return this.resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE)
      .filter((c) => !c.metadata.deletionTimestamp && (!id || c.spec.id === id));
  }
  async archive(id: string, outputs: OutputDraft[], receipts: Array<{ key: string; responseId: string }> = []): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const c = await this.ensure(id);
      try {
        await commitStatus(this.client, [
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
  async say(topicId: string, inputId: string | undefined, text: string, executionId?: string,
    options: Omit<SayInput, "text"> = {}, owner?: import("@compforge/aide-plugin").Resource<unknown, { agent?: import("@compforge/aide-plugin").AgentStatus; execution?: { id: string } | null }>): Promise<SayReceipt> {
    const initial = await this.ensure(topicId);
    const id = options.idempotencyKey ? digest([initial.metadata.uid, executionId ?? "", options.idempotencyKey]) : randomUUID();
    const previous = this.outputStore.get(id);
    if (options.respondToInputId && (options.target || options.to || options.channelId)) throw new Error("say must choose respondToInputId or target, not both");
    const inputIds = [...new Set([...(options.inputIds ?? (inputId ? [inputId] : [])), ...(options.respondToInputId ? [options.respondToInputId] : [])])];
    const attached = (id: string) => {
      const input = this.inputStore.get(id);
      const members = new Set(this.scope(initial.metadata.uid).map(t => t.metadata.uid));
      const assigned = owner ? input?.status.handle?.[owner.metadata.uid] : input &&
        (belongsToTopic(input, resourceRef(initial), members));
      if (!input || !assigned) throw new Error(`say Input is not attached to this Topic: ${id}`);
      return input;
    };
    for (const id of inputIds) attached(id);
    let target: Address | undefined = options.target && parseAddress(options.target);
    let receivers = options.receivers === undefined ? undefined : [...options.receivers];
    if (options.to || options.channelId) {
      if (options.receivers !== undefined) throw new Error("say must choose to or receivers, not both");
      if (options.target && options.channelId) throw new Error("say must choose target or channelId, not both");
      if (!options.to) throw new Error("say channelId requires an explicit recipient");
      if (!this.resolveContact) throw new Error("Person contact is unavailable");
      if (previous) {
        const recipient = options.to;
        if ("personId" in recipient && !previous.spec.receivers?.some(r => r.uid === recipient.uid)) throw new Error("Output identity already exists with a different recipient");
        target = previous.spec.target; receivers = previous.spec.receivers;
      } else {
        const destination = await this.resolveContact(topicId, options.to, options.channelId, target);
        target = destination.target; receivers = destination.receivers;
      }
    }
    if (options.respondToInputId) {
      const reply = attached(options.respondToInputId).spec;
      // @spec Only Channel inputs establish an implicit reply path. Source addresses locate observations, not assistant conversations.
      // @link docs/kernel.md#观察委托与代理
      // @case tests/address.test.ts
      if (reply.origin !== "channel") throw new Error("Direct replies require a Channel Input; an observation or assistant decision is not a direct request. Remain silent or choose an independently known, authorized notification target.");
      target = reply.source;
      // A direct reply identifies its sender; explicit receivers (including []) remain the caller's decision.
      if (receivers === undefined && reply.sender) receivers = [reply.sender];
      if (!target) throw new Error(`Reply Input has no address: ${options.respondToInputId}`);
    }
    // A repeated tool call keeps its admitted destination even if new immediate Inputs have arrived.
    if (!target && previous) {
      target = previous.spec.target;
      receivers ??= previous.spec.receivers;
    }
    if (!target) {
      const candidates = (inputIds.length ? inputIds : owner ? [] : this.pending(initial.metadata.uid).map(i => i.metadata.name)).map(attached)
        .filter((i) => i.spec.origin === "channel" && inputAttention(i.spec) === InputAttention.Immediate);
      if (candidates.length) {
        const first = candidates[0]!.spec.source;
        if (first && candidates.every(i => i.spec.source && sameAddress(first, i.spec.source))) target = first;
      }
      // @spec Rules resolve an unambiguous reply; the Agent can choose an explicit address. An unresolved choice contacts Me.
      // @link docs/personal/output.md#地址与收件处
      if (!target && this.resolveContact) {
        const destination = await this.resolveContact(topicId);
        target = destination.target;
        if (receivers !== undefined && JSON.stringify(receivers) !== JSON.stringify(destination.receivers))
          throw new Error("Default say contacts Me; other receivers require an explicit target");
        receivers = destination.receivers;
      }
    }
    if (!target) throw new Error("say requires an explicit target or a configured default Channel");
    for (let attempt = 0; ; attempt++) {
      const c = this.resource(topicId);
      if (!c || c.metadata.uid !== initial.metadata.uid) throw new Error("Output Topic was replaced");
      if (owner) {
        const latest = await this.client.get<unknown, { agent?: import("@compforge/aide-plugin").AgentStatus; execution?: { id: string } | null }>(resourceRef(owner));
        if (!latest || latest.metadata.deletionTimestamp) throw new Error("Output owner is no longer active");
        owner = latest;
      }
      if (executionId && (owner ? owner.status.execution?.id : c.status.execution?.id) !== executionId) throw new Error("Output execution is no longer active");
      const draft: OutputDraft = { id, topicId, text, workId: null };
      // @spec Provenance belongs to the first admission. System notices have no agent execution;
      // their deduplication key is not a tool-call ID, even when this Topic has an active Chief.
      // @link docs/observation.md
      // @case tests/output.test.ts
      const accepted = this.outputStore.get(id);
      const createdBy = accepted ? accepted.spec.createdBy
        : executionId ? agentCall((owner ?? c).status, options.idempotencyKey) : undefined;
      const association = { ...(createdBy ? { createdBy } : {}), ...(owner ? { producer: resourceRef(owner) } : {}), target, ...(receivers !== undefined ? { receivers } : {}), ...(executionId ? { executionId } : {}), ...(inputIds.length ? { inputIds, inputUids: Object.fromEntries(inputIds.map(id => [id, attached(id).metadata.uid])) } : {}) };
      try {
        await commitStatus(this.client, [
          { operation: "patchStatus", resource: c, patch: {} },
          ...(owner ? [{ operation: "patchStatus" as const, resource: owner, patch: {} }] : []),
          outputWrite(c, draft, association),
        ]);
        return { outputId: id, accepted: true };
      } catch (error) { if (attempt >= 8 || !/version conflict/.test(String(error))) throw error; }
    }
  }
  scope(uid: string) {
    const storage = this.resources.storage;
    const row = storage.db.prepare("SELECT key FROM resources WHERE uid = ? AND scope = ? AND kind = 'aide.dev/Topic' AND json_extract(data, '$.object.apiVersion') = 'aide.dev/v1alpha3'")
      .get(uid, this.resources.scope);
    const root = row ? storage.read(row.key as string)?.object as TopicResource | undefined : undefined;
    return root && root.metadata.namespace === "v1" ? topicSubtree(root, parent => this.resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE,
      { namespace: parent.metadata.namespace, matchIndex: { name: "parent", value: parent.metadata.uid } })) : [];
  }
  pending(uid: string) {
    const inputs = this.scope(uid).flatMap(t => this.inputStore.query("assessPending", t.metadata.uid));
    return [...new Map(inputs.map(i => [i.metadata.uid, i])).values()];
  }
  private project(r: TopicResource): Topic {
    const pending = this.pending(r.metadata.uid);
    return { ...r.spec, name: r.spec.name || initialTopicName(pending[0]?.spec.text ?? ""), revision: Number(r.metadata.resourceVersion), createdAt: r.metadata.creationTimestamp,
      pendingInputIds: pending.map(i => i.metadata.name), outputs: this.outputStore.list({ topicUid: r.metadata.uid }).map(outputView) };
  }
}
