import type { AddressSpec, AddressStatus, AddressRef } from "../address/model.ts";
import { KeyedSet } from "@compforge/ts-stdx/collections";
import { personRef, personRefs } from "../person/model.ts";
import { disclosurePolicy, type PolicyNote } from "./policy.ts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Address, Resource, ResourceRef } from "@compforge/aide-plugin";
import type { Logger } from "pino";
import { NOTE_TYPE, noteVersion, noteTextVersion, type NoteResource } from "../note/model.ts";
import { isMe, type Me, type PersonResource, type Person, type PersonStatus } from "../person/model.ts";
import { sensitivityRank } from "../disclosure.ts";
import type { TopicSpec, TopicStatus } from "../topic/model.ts";
import { INPUT_TYPE, InputAttention, inputAttention, type InputSpec, type InputStatus } from "../input/model.ts";
import { MUTED_OUTPUT_TEXT, isMutedNotice, receiverIdentity, type Output } from "./model.ts";
import type { OutputStore } from "./store.ts";

export interface OutputAudience { people: PersonResource[]; private: boolean; muted?: boolean; unavailable?: string }
export interface DisclosureEvidence { text: string; materials: Array<{ id: string; text: string }> }
export type SemanticCheck = (evidence: DisclosureEvidence) => Promise<{ allowed: boolean; reason: string }>;
export interface DisclosurePorts {
  marks: Me;
  audience(target: AddressRef): Promise<OutputAudience>;
  contactMe(topicId: string): Promise<{ address: AddressRef; target: Address; receivers: ResourceRef[] }>;
  check?: SemanticCheck;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");


/**
 * @spec Content/intent remain immutable. Only a persisted, checked actual delivery can cross a Channel boundary.
 * @spec Me's exemption depends on verified private destination identity, never intended receivers alone.
 * @spec Immediate Input Outputs replace muted content with a fixed notice at the intended address; other refusals contact Me.
 * @why Reconcile owns actual target/stream; Chief's raw intent stays immutable, and retries never rerun Chief.
 * @case tests/address-resource.test.ts
 * @link docs/personal/disclosure.md
 */
export class OutputDisclosure {
  private readonly running = new Map<string, Promise<void>>();
  constructor(private readonly store: OutputStore, private readonly ports: DisclosurePorts, private readonly log: Logger) {}
  reconcile(id: string): Promise<void> {
    const existing = this.running.get(id);
    if (existing) return existing;
    const run = this.run(id).catch(error => {
      this.store.update(id, status => ({ ...status, lastError: "Output disclosure preparation failed; original destination has not been authorized" }));
      this.log.warn({ outputId: id }, "Output disclosure preparation failed; retry required");
      throw error;
    }).finally(() => this.running.delete(id));
    this.running.set(id, run);
    return run;
  }
  private async audience(target: AddressRef): Promise<OutputAudience> {
    const audience = await this.ports.audience(target);
    // Canonicalize before collecting dependencies as well as before choosing actual receivers.
    return { ...audience, people: [...new KeyedSet(person => person.metadata.uid, audience.people)].sort((a, b) => a.metadata.uid < b.metadata.uid ? -1 : a.metadata.uid > b.metadata.uid ? 1 : 0) };
  }
  private addressPolicy(ref: AddressRef) {
    const address = this.store.resources.find<AddressSpec, AddressStatus>(ref, ref.name, ref.namespace);
    return address && hash([address.metadata.uid, address.metadata.deletionTimestamp, address.spec.endpoint, address.spec.type, address.spec.muted, [...address.status.people].map(p => p.uid).sort()]);
  }
  private hasImmediateInput(output: Output): boolean {
    const refs = new Map(Object.entries(output.spec.inputUids ?? {}));
    if (output.spec.replyTo) refs.set(output.spec.replyTo.input.name, output.spec.replyTo.input.uid);
    return [...refs].some(([name, uid]) => {
      const input = this.store.resources.find<InputSpec, InputStatus>(INPUT_TYPE, name, "v1");
      return input?.metadata.uid === uid && !input.metadata.deletionTimestamp && inputAttention(input.spec) === InputAttention.Immediate;
    });
  }
  private snapshot(output: Output, audience: OutputAudience) {
    const immediate = !!audience.muted && this.hasImmediateInput(output);
    const dependencies: unknown[] = [this.addressPolicy(output.spec.target), immediate];
    const materials: DisclosureEvidence["materials"] = [];
    let refusal = audience.unavailable ?? (audience.muted ? "Aide is muted at this Address" : audience.people.length ? "" : "No known destination participants");
    const get = <S, T>(ref: ResourceRef & { uid?: string }): Resource<S, T> | undefined => {
      const r = this.store.resources.find<S, T>(ref, ref.name, ref.namespace);
      dependencies.push([ref, r && [r.metadata.uid, r.metadata.deletionTimestamp, r.kind === "Person" ? personDisclosure(r.spec as Person) : r.spec]]);
      return r && r.metadata.uid === ref.uid && !r.metadata.deletionTimestamp ? r : undefined;
    };
    const livePeople = audience.people.map(p => get<Person, PersonStatus>({ apiVersion: p.apiVersion, kind: p.kind, namespace: p.metadata.namespace, name: p.metadata.name, uid: p.metadata.uid }));
    if (livePeople.some(p => !p)) refusal ||= "Destination Person changed or was deleted";
    audience = { ...audience, people: livePeople.filter((p): p is PersonResource => !!p) };
    const policyNotes: PolicyNote[] = [];
    const topicFor = (ref: ResourceRef): Resource<TopicSpec, TopicStatus> | undefined => {
      const subject = get<TopicSpec, TopicStatus & { topic?: ResourceRef }>(ref);
      if (!subject) return;
      if (subject.kind === "Topic") return subject;
      return subject.status.topic ? get<TopicSpec, TopicStatus>(subject.status.topic) : undefined;
    };
    for (const ref of output.spec.notes ?? []) {
      const note = this.store.resources.page<NoteResource["spec"], NoteResource["status"]>(NOTE_TYPE, { namespace: "v1", limit: 1, matchIndex: { name: "uid", value: ref.uid } }).items[0];
      dependencies.push([ref, note && [note.metadata.uid, note.metadata.deletionTimestamp, note.spec, note.status.updatedAt]]);
      if (!note || note.metadata.deletionTimestamp || (ref.textVersion ? noteTextVersion(note) !== ref.textVersion : noteVersion(note) !== ref.version)) {
        refusal ||= `Note ${ref.uid} is missing or changed since generation`; continue;
      }
      materials.push({ id: ref.uid, text: note.spec.text });
      const item: PolicyNote = { sensitivity: note.spec.sensitivity ?? "L3", visibility: note.spec.visibility ?? "people", people: [...note.spec.people].map(p => p.uid) };
      if (item.visibility === "topic" || item.visibility === "root") {
        let topic = topicFor(note.spec.subject);
        item.topicPeople = topic ? [...topic.spec.people ?? []].map(p => p.uid) : undefined;
        const visited = new Set<string>();
        while (item.visibility === "root" && topic?.spec.parentRef) {
          if (visited.has(topic.metadata.uid)) { topic = undefined; break; }
          visited.add(topic.metadata.uid);
          topic = get<TopicSpec, TopicStatus>(topic.spec.parentRef);
        }
        item.rootPeople = topic ? [...topic.spec.people ?? []].map(p => p.uid) : undefined;
      }
      policyNotes.push(item);
    }
    const policy = disclosurePolicy(policyNotes);
    if (!policy) refusal ||= "No verifiable Note scope; cannot establish disclosure permission";
    if (policy) for (const recipient of audience.people) {
      if (isMe(recipient.spec, this.ports.marks)) continue;
      if (sensitivityRank(policy.sensitivity) > sensitivityRank(recipient.spec.clearance ?? "L1"))
        refusal ||= `Output sensitivity ${policy.sensitivity} exceeds ${recipient.metadata.name}'s clearance ${recipient.spec.clearance ?? "L1"}`;
      if (policy.visibility !== "any" && !policy.people.includes(recipient.metadata.uid))
        refusal ||= `Recipient ${recipient.metadata.name} is outside visibility ${policy.visibility}`;
    }
    const privateMe = audience.private && audience.people.length === 1 && isMe(audience.people[0]!.spec, this.ports.marks);
    return { policy, immediate, fingerprint: hash([receiverIdentity(output.spec), policy, dependencies, { ...audience, people: audience.people.map(p => [p.metadata.uid, p.metadata.deletionTimestamp, personDisclosure(p.spec)]) }, this.ports.marks]), privateMe,
      refusal: privateMe && !audience.muted && !audience.unavailable ? "" : refusal, evidence: { text: [this.store.content(output).think, this.store.content(output).text].filter(Boolean).join("\n\n"), materials } };
  }
  private isMuteNotice(output: Output) {
    const content = this.store.content(output, true);
    return content.phase === "completed" && !content.think && isMutedNotice({ notice: output.status.delivery?.notice, text: content.text });
  }
  private async run(id: string) {
    const output = this.store.get(id);
    if (!output || output.metadata.deletionTimestamp || ["delivered", "failed", "uncertain", "cancelled"].includes(output.status.phase)) return;
    // A refused Output keeps its saved notice or Me fallback. Permission changes never resurrect its original intent.
    if (output.status.disclosure?.decision === "denied" && output.status.delivery) {
      const audience = await this.audience(output.status.delivery.address);
      if (this.isMuteNotice(output)) {
        if (audience.unavailable || output.status.delivery.address.uid !== output.spec.target.uid)
          throw new Error("Saved mute notice destination is no longer available");
        return;
      }
      if (audience.unavailable || audience.muted || !audience.private || audience.people.length !== 1 || !isMe(audience.people[0]!.spec, this.ports.marks))
        throw new Error("Saved fallback destination is no longer a verified private Me channel");
      return;
    }
    const audience = await this.audience(output.spec.target);
    const snapshot = this.snapshot(output, audience);
    // Recheck an existing authorization before waiting for external review: a formerly private
    // destination must never keep receiving new chunks after its audience changes.
    if ((output.status.phase === "sending" || (output.status.attempts > 0 && this.store.content(output).phase === "open"))
      && snapshot.fingerprint !== output.status.disclosure?.fingerprint) {
      this.store.uncertain(id, "Disclosure changed during delivery; verify external receipts"); return;
    }
    // A private Me destination authorizes ongoing content. External destinations require a complete reviewed body.
    if (!snapshot.privateMe && !audience.muted && this.store.content(output).phase === "open") {
      if (output.status.delivery) this.store.update(id, status => ({ ...status, delivery: undefined, disclosure: undefined }));
      return;
    }
    let reason = output.status.disclosure?.decision === "denied" ? output.status.disclosure.reason : snapshot.refusal;
    if (!reason && !snapshot.privateMe && output.status.disclosure?.fingerprint !== snapshot.fingerprint) {
      if (!this.ports.check) reason = "Content/reference verification is unavailable";
      else if (JSON.stringify(snapshot.evidence).length > 100_000) reason = "Evidence exceeds the bounded disclosure review budget";
      else {
        try {
          const verdict = await this.ports.check(snapshot.evidence);
          if (!verdict.allowed) reason = verdict.reason || "Content is not supported by the disclosed materials";
        } catch { reason = "Content/reference verification failed; original message was not sent"; }
      }
    }
    if (!reason && output.status.disclosure?.decision === "allowed" && output.status.disclosure.fingerprint === snapshot.fingerprint && output.status.delivery) return;
    if (reason && output.status.attempts > 0) {
      this.store.uncertain(id, "Disclosure changed after a send attempt; inspect provider receipts before any further delivery");
      this.log.warn({ outputId: id }, "Output permission changed after attempted delivery"); return;
    }
    const decision = reason ? "denied" : "allowed";
    let fallbackPeople: PersonResource[] = [];
    let fallbackPolicy: string | undefined;
    let delivery: NonNullable<Output["status"]["delivery"]> = { ...(output.status.delivery?.replay ? { replay: output.status.delivery.replay } : {}), address: output.spec.target, target: this.store.destination(output), stream: output.spec.stream, receivers: personRefs(audience.people.map(personRef)) };
    if (reason && audience.muted && !audience.unavailable && snapshot.immediate) {
      delivery = { ...delivery, notice: "muted", stream: this.store.replacement(output, "muted", MUTED_OUTPUT_TEXT) };
    } else if (reason) {
      this.store.update(id, status => ({ ...status, delivery: undefined, disclosure: { decision: "denied", reason, checkedAt: new Date().toISOString(), fingerprint: snapshot.fingerprint, ...(snapshot.policy ? { policy: snapshot.policy } : {}) } }));
      const me = await this.ports.contactMe(output.spec.topicId);
      this.store.update(id, status => ({ ...status, waitingAddress: me.address }));
      const fallback = await this.audience(me.address);
      if (fallback.unavailable || fallback.muted || !fallback.private || fallback.people.length !== 1 || !isMe(fallback.people[0]!.spec, this.ports.marks)) throw new Error("Default Address is not a verified private Me destination");
      fallbackPeople = fallback.people;
      fallbackPolicy = this.addressPolicy(me.address);
      delivery = { ...me, receivers: personRefs(fallback.people.map(personRef)), stream: audience.muted ? output.spec.stream : this.store.replacement(output, "disclosure", `原计划发送至：${JSON.stringify(output.spec.target)}\n未发送原因：${reason}\n\n原文：\n${this.store.content(output).text}`) };
    }
    // Awaited model/provider calls cannot authorize a changed resource or audience.
    const currentAudience = await this.audience(output.spec.target);
    this.store.storage.transaction(() => {
      const latest = this.store.get(id);
      if (!latest || latest.status.phase !== "pending") return;
      if (this.snapshot(latest, currentAudience).fingerprint !== snapshot.fingerprint) throw new Error("Disclosure dependencies changed during review; retry with current evidence");
      if (decision === "denied" && delivery.notice !== "muted" && this.addressPolicy(delivery.address) !== fallbackPolicy) throw new Error("Fallback Address changed before delivery commit");
      if (decision === "denied" && fallbackPeople.some(person => {
        const latestPerson = this.store.resources.find<Person, PersonStatus>(person, person.metadata.name, person.metadata.namespace);
        return !latestPerson || latestPerson.metadata.uid !== person.metadata.uid || latestPerson.metadata.deletionTimestamp || !isMe(latestPerson.spec, this.ports.marks);
      })) throw new Error("Me identity changed before fallback commit");
      if (latest.status.attempts > 0 && !isDeepStrictEqual(receiverIdentity(latest.status.delivery), receiverIdentity(delivery))) {
        this.store.uncertain(id, "Actual recipients changed after a send attempt; verify external receipts"); return;
      }
      this.store.update(id, status => ({ ...status, disclosure: { decision, reason: reason || "Destination is permitted", checkedAt: new Date().toISOString(), fingerprint: snapshot.fingerprint, ...(snapshot.policy ? { policy: snapshot.policy } : {}) }, delivery,
        waitingAddress: undefined, lastError: undefined }));
    });
    this.log.info({ outputId: id, decision, notice: delivery.notice, actualTarget: delivery.target }, "Output disclosure resolved");
  }
}

/** @spec Delivery timing is not disclosure permission; editing it cannot invalidate an attempted Output's authorization. */
function personDisclosure(person: Person) {
  const { delivery: _delivery, ...disclosure } = person;
  return disclosure;
}
