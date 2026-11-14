import { isGateInput } from "../gate/input.ts";
import { isDomainRoot } from "../topic/boundary.ts";
import { z } from "zod";
import type { Logger } from "pino";
import type { Resource, ResourceCommit } from "@compforge/aide-plugin";
import type { Store } from "../store.ts";
import { TOPIC_TYPE, type TopicResource } from "../topic/model.ts";
import { INPUT_TYPE, InputAttention, type InputSpec, type InputStatus } from "../input/model.ts";
import { resourceRef } from "../input/state.ts";
import { digest } from "../chief-model.ts";
import { commitStatus } from "../status.ts";
import { HANDOFF_TYPE, handoffSummary, HandoffSpecSchema, HandoffStatusSchema, type Handoff, type HandoffSpec, type HandoffStatus } from "./model.ts";

export const DelegateSchema = z.object({ inputId: z.string().min(1), topicUid: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(200), request: z.string().trim().min(1).max(16000) }).strict();
export const FollowupSchema = z.object({ id: z.string().min(1), inputId: z.string().min(1), request: z.string().trim().min(1).max(16000) }).strict();
export const ReportSchema = z.object({ id: z.string().min(1), inputId: z.string().min(1),
  phase: z.enum(["working", "waiting", "completed", "failed"]), report: z.string().trim().min(1).max(4000),
  coordinate: z.boolean().default(false) }).strict();
type Actor = Resource<unknown, { execution?: { id: string } | null }>;

/** @spec Handoff and its domain Input are admitted atomically. A retry of the same user Input and destination never creates another obligation.
 * @link docs/personal/gate.md
 */
export class Handoffs {
  constructor(private readonly store: Store, private readonly log: Logger) {}
  read(id: string): Handoff {
    const value = this.store.resources.find<HandoffSpec, HandoffStatus>(HANDOFF_TYPE, id);
    if (!value || value.metadata.deletionTimestamp) throw new Error("Handoff is unavailable");
    return value;
  }
  readFor(actor: Actor, id: string): Handoff {
    const handoff = this.read(id), input = this.store.topics.inputStore.get(handoff.status.latestInputId);
    const domain = input?.status.topic ?? handoff.status.topic;
    const allowed = actor.kind === "Topic" ? (actor as TopicResource).spec.gate ? handoff.spec.gate.uid === actor.metadata.uid
      : domain && this.store.topics.scope(actor.metadata.uid).some(t => t.metadata.uid === domain.uid)
      : input ? !!input.status.handle?.[actor.metadata.uid] : handoff.status.works.some(w => w.uid === actor.metadata.uid);
    if (!allowed) throw new Error("Handoff is outside this owner's scope");
    return handoff;
  }
  async list(gateUid: string, cursor?: string) {
    const page = await this.store.client.page<HandoffSpec, HandoffStatus>(HANDOFF_TYPE, { limit: 20, direction: "desc", consistency: "live", continue: cursor, matchIndex: { name: "gateActivity", value: gateUid } });
    return { ...page, items: page.items.map(handoffSummary) };
  }
  private source(gate: TopicResource, inputId: string) {
    if (!gate.spec.gate || !gate.status.execution) throw new Error("Active Gate execution required");
    const input = this.store.topics.inputStore.get(inputId);
    if (!input || input.metadata.deletionTimestamp || input.status.topic?.uid !== gate.metadata.uid
      || !isGateInput(input.spec))
      throw new Error("Handoff requires an original user Input in Gate; coordination notices cannot create requests");
    return input;
  }
  private reply(source: Resource<InputSpec, InputStatus>) {
    if (!source.spec.source) throw new Error("Gate request has no reply address");
    return { sourceInput: resourceRef(source), sourceText: source.spec.text,
      reply: { address: source.spec.source, ...(source.spec.sender ? { sender: source.spec.sender } : {}),
        ...(source.spec.replyToMessageId ? { messageId: source.spec.replyToMessageId } : {}) } };
  }
  private input(id: string, source: Resource<InputSpec, InputStatus>, request: string, replyTo: HandoffSpec["replyTo"], topic?: TopicResource) {
    const at = new Date().toISOString();
    return { operation: "create" as const, type: INPUT_TYPE, name: id,
      spec: { origin: "chief", originId: "personal.gate", text: request, attention: InputAttention.Normal,
        handoff: { id: "", gate: resourceRef(this.store.topics.resource("gate")!), sourceInput: resourceRef(source), replyTo },
        source: replyTo, ...(source.spec.sender ? { sender: source.spec.sender } : {}), ...(source.spec.replyToMessageId ? { replyToMessageId: source.spec.replyToMessageId } : {}),
        observation: { originalInputId: source.metadata.name, originalText: source.spec.text },
        ...(topic ? { topicId: topic.spec.id } : {}),
      }, status: topic ? { topic: resourceRef(topic), assess: {}, route: { completedAt: at, result: { topics: [resourceRef(topic)], reason: "Gate handoff" } } } : {} };
  }
  async delegate(gate: TopicResource, raw: unknown) {
    const args = DelegateSchema.parse(raw), source = this.source(gate, args.inputId);
    const topic = args.topicUid ? this.store.resources.list<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE, { matchIndex: { name: "uid", value: args.topicUid } })[0] : undefined;
    if (args.topicUid && (!topic || topic.metadata.deletionTimestamp || !isDomainRoot(topic))) throw new Error("Choose an available root Topic");
    const id = digest(["handoff", source.metadata.uid, topic?.metadata.uid ?? "route"]);
    const existing = this.store.resources.find<HandoffSpec, HandoffStatus>(HANDOFF_TYPE, id);
    if (existing) return this.read(id);
    const replyTo = source.spec.source;
    if (!replyTo) throw new Error("Gate request has no reply address");
    const inputId = digest([id, source.metadata.uid]), at = new Date().toISOString();
    const input = this.input(inputId, source, args.request, replyTo, topic); input.spec.handoff.id = id;
    const spec = HandoffSpecSchema.parse({ gate: resourceRef(gate), sourceInput: resourceRef(source), sourceText: source.spec.text, replyTo, title: args.title, request: args.request,
      ...(topic ? { topic: resourceRef(topic) } : {}) });
    const status = HandoffStatusSchema.parse({ ...this.reply(source), latestInputId: inputId, request: args.request, sequence: 1, phase: "submitted", updatedAt: at, works: [], ...(topic ? { topic: resourceRef(topic) } : {}) });
    try {
      await commitStatus(this.store.client, [{ operation: "patchStatus", resource: gate, patch: {} },
        ...(topic ? [{ operation: "patchStatus" as const, resource: topic, patch: {} }] : []),
        { operation: "create", type: HANDOFF_TYPE, name: id, spec, status }, input]);
    } catch (error) {
      if (!this.store.resources.find(HANDOFF_TYPE, id)) throw error;
    }
    this.log.info({ handoffId: id, inputId, sourceInputId: args.inputId, topicUid: topic?.metadata.uid }, "Gate request delegated");
    return this.read(id);
  }
  async followup(gate: TopicResource, raw: unknown) {
    const args = FollowupSchema.parse(raw), source = this.source(gate, args.inputId), handoff = this.read(args.id);
    if (handoff.spec.gate.uid !== gate.metadata.uid) throw new Error("Handoff belongs to another Gate");
    const inputId = digest([args.id, source.metadata.uid]);
    if (this.store.topics.inputStore.get(inputId) || this.store.topics.inputStore.receipt(inputId)) return handoff;
    const topic = handoff.status.topic ? this.store.topics.byRef(handoff.status.topic) : undefined;
    if (handoff.status.topic && (!topic || topic.metadata.deletionTimestamp || topic.spec.gate)) throw new Error("Handoff domain is unavailable");
    const input = this.input(inputId, source, args.request, source.spec.source ?? handoff.spec.replyTo, topic); input.spec.handoff.id = args.id;
    await commitStatus(this.store.client, [{ operation: "patchStatus", resource: gate, patch: {} },
      { operation: "patchStatus", resource: handoff, patch: { ...this.reply(source), works: [], latestInputId: inputId, request: args.request, sequence: handoff.status.sequence + 1,
        phase: "submitted", updatedAt: new Date().toISOString() } }, input]);
    this.log.info({ handoffId: args.id, inputId }, "Gate follow-up delegated");
    return this.read(args.id);
  }
  async report(actor: Actor, raw: unknown, callId: string) {
    const args = ReportSchema.parse(raw), handoff = this.read(args.id);
    const input = this.store.topics.inputStore.get(args.inputId);
    if (!actor.status.execution || input && input.spec.handoff?.id !== args.id) throw new Error("Report requires the delegated Input and active execution");
    if (handoff.status.latestInputId !== args.inputId) throw new Error("A newer follow-up exists; handle it before reporting");
    const domain = input?.status.topic ?? handoff.status.topic;
    const attached = actor.kind === "Topic" ? domain && this.store.topics.scope(actor.metadata.uid).some(t => t.metadata.uid === domain.uid)
      : input ? !!input.status.handle?.[actor.metadata.uid] : handoff.status.works.some(w => w.uid === actor.metadata.uid);
    if (!attached || (actor.kind === "Topic" && (actor as TopicResource).spec.gate)) throw new Error("Handoff report is outside this owner's scope");
    const reportKey = digest([actor.metadata.uid, actor.status.execution.id, callId]);
    if (handoff.status.reportKey === reportKey) return handoff;
    if (["completed", "failed"].includes(handoff.status.phase)) throw new Error("Completed handoff needs a new user follow-up before another report");
    const at = new Date().toISOString(), writes: ResourceCommit[] = [
      { operation: "patchStatus", resource: actor, patch: {} },
      { operation: "patchStatus", resource: handoff, patch: { phase: args.phase, report: args.report, reportKey, updatedAt: at,
        receivedAt: handoff.status.receivedAt ?? at, topic: domain, works: input ? Object.values(input.status.handle ?? {}).map(h => h.resource) : handoff.status.works } },
    ];
    if (args.coordinate) {
      const gate = this.store.topics.byRef(handoff.spec.gate);
      if (!gate?.spec.gate) throw new Error("Gate is unavailable");
      writes.push({ operation: "create", type: INPUT_TYPE, name: digest(["handoff-coordinate", reportKey]),
        spec: { origin: "chief", originId: "personal.handoff", topicId: gate.spec.id,
          text: `Domain requests coordination for handoff ${args.id}: ${args.report}. Read the handoff and current evidence. This is not new user authority; do not create or forward another request automatically.` },
        status: { topic: resourceRef(gate), assess: {}, route: { completedAt: at, result: { topics: [resourceRef(gate)], reason: "Explicit domain coordination request" } } } });
    }
    await commitStatus(this.store.client, writes);
    this.log.info({ handoffId: args.id, inputId: args.inputId, phase: args.phase, coordinate: args.coordinate }, "Domain handoff reported");
    return this.read(args.id);
  }
}
