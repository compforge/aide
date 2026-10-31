import { KeyedSet } from "@compforge/ts-stdx/collections";
import { personRef, personRefs, PersonRefsSchema } from "../person/model.ts";
import { disclosurePolicy, type PolicyNote } from "./policy.ts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Address, Resource, ResourceRef } from "@compforge/aide-plugin";
import type { Logger } from "pino";
import { NOTE_TYPE, noteVersion, noteTextVersion, type NoteResource } from "../note/model.ts";
import { isMe, type Me, type PersonResource, type Person, type PersonStatus } from "../person/model.ts";
import { sensitivityRank } from "../disclosure.ts";
import type { TopicSpec, TopicStatus } from "../topic/model.ts";
import { receiverIdentity, type Output } from "./model.ts";
import type { OutputStore } from "./store.ts";

export interface OutputAudience { people: PersonResource[]; complete: boolean; private: boolean }
export interface DisclosureEvidence { text: string; materials: Array<{ id: string; text: string }> }
export type SemanticCheck = (evidence: DisclosureEvidence) => Promise<{ allowed: boolean; reason: string }>;
export interface DisclosurePorts {
  marks: Me;
  audience(target: Address): Promise<OutputAudience>;
  contactMe(topicId: string): Promise<{ target: Address; receivers: ResourceRef[] }>;
  check?: SemanticCheck;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");


/**
 * @spec Content/intent remain immutable. Only a persisted, checked actual delivery can cross a Channel boundary.
 * @spec Me's exemption depends on verified private destination identity, never intended receivers alone.
 * @why Permission refusal is delivered to Me on this same Output; retries never create a second Output or rerun Chief.
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
  private async audience(target: Address): Promise<OutputAudience> {
    const audience = await this.ports.audience(target);
    // Canonicalize before collecting dependencies as well as before choosing actual receivers.
    return { ...audience, people: [...new KeyedSet(person => person.metadata.uid, audience.people)].sort((a, b) => a.metadata.uid < b.metadata.uid ? -1 : a.metadata.uid > b.metadata.uid ? 1 : 0) };
  }
  private snapshot(output: Output, audience: OutputAudience) {
    const dependencies: unknown[] = [];
    const materials: DisclosureEvidence["materials"] = [];
    let refusal = audience.complete && audience.people.length ? "" : "Cannot establish the complete destination audience";
    const get = <S, T>(ref: ResourceRef & { uid?: string }): Resource<S, T> | undefined => {
      const r = this.store.resources.find<S, T>(ref, ref.name, ref.namespace);
      dependencies.push([ref, r && [r.metadata.uid, r.metadata.deletionTimestamp, r.kind === "Person" ? personDisclosure(r.spec as Person) : r.spec]]);
      return r && r.metadata.uid === ref.uid && !r.metadata.deletionTimestamp ? r : undefined;
    };
    const livePeople = audience.people.map(p => get<Person, PersonStatus>({ apiVersion: p.apiVersion, kind: p.kind, namespace: p.metadata.namespace, name: p.metadata.name, uid: p.metadata.uid }));
    if (livePeople.some(p => !p)) refusal ||= "Destination Person changed or was deleted";
    audience = { ...audience, complete: audience.complete && livePeople.every(Boolean), people: livePeople.filter((p): p is PersonResource => !!p) };
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
    const privateMe = audience.complete && audience.private && audience.people.length === 1 && isMe(audience.people[0]!.spec, this.ports.marks);
    return { policy, fingerprint: hash([receiverIdentity(output.spec), policy, dependencies, { ...audience, people: audience.people.map(p => [p.metadata.uid, p.metadata.deletionTimestamp, personDisclosure(p.spec)]) }, this.ports.marks]), privateMe,
      refusal: privateMe ? "" : refusal, evidence: { text: output.spec.text, materials } };
  }
  private async run(id: string) {
    const output = this.store.get(id);
    if (!output || output.metadata.deletionTimestamp || ["delivered", "failed", "uncertain"].includes(output.status.phase)) return;
    // A refused Output has only a Me delivery left. Permission changes never silently resurrect its original intent.
    if (output.status.disclosure?.decision === "denied" && output.status.delivery) {
      const audience = await this.audience(output.status.delivery.target);
      if (!audience.complete || !audience.private || audience.people.length !== 1 || !isMe(audience.people[0]!.spec, this.ports.marks))
        throw new Error("Saved fallback destination is no longer a verified private Me channel");
      return;
    }
    let audience: OutputAudience;
    try { audience = await this.audience(output.spec.target); }
    catch { audience = { people: [], complete: false, private: false }; }
    const snapshot = this.snapshot(output, audience);
    if (output.status.phase === "sending") {
      if (snapshot.fingerprint !== output.status.disclosure?.fingerprint) this.store.uncertain(id, "Disclosure changed after an interrupted send; verify external receipts");
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
    let delivery: NonNullable<Output["status"]["delivery"]> = { ...(output.status.delivery?.replay ? { replay: output.status.delivery.replay } : {}), target: output.spec.target, text: output.spec.text, receivers: personRefs(audience.people.map(personRef)) };
    if (reason) {
      this.store.update(id, status => ({ ...status, delivery: undefined, disclosure: { decision: "denied", reason, checkedAt: new Date().toISOString(), fingerprint: snapshot.fingerprint, ...(snapshot.policy ? { policy: snapshot.policy } : {}) } }));
      const me = await this.ports.contactMe(output.spec.topicId);
      const fallback = await this.audience(me.target);
      if (!fallback.complete || !fallback.private || fallback.people.length !== 1 || !isMe(fallback.people[0]!.spec, this.ports.marks)) throw new Error("Default Channel is not a verified private Me destination");
      fallbackPeople = fallback.people;
      delivery = { ...me, receivers: PersonRefsSchema().parse(me.receivers), text: `原计划发送至：${JSON.stringify(output.spec.target)}\n接收者：${JSON.stringify(output.spec.receivers ?? [])}\n未发送原因：${reason}\n\n原文：\n${output.spec.text}` };
    }
    // Awaited model/provider calls cannot authorize a changed resource or audience.
    let currentAudience: OutputAudience;
    try { currentAudience = await this.audience(output.spec.target); }
    catch { currentAudience = { people: [], complete: false, private: false }; }
    this.store.storage.transaction(() => {
      const latest = this.store.get(id);
      if (!latest || latest.status.phase !== "pending") return;
      if (this.snapshot(latest, currentAudience).fingerprint !== snapshot.fingerprint) throw new Error("Disclosure dependencies changed during review; retry with current evidence");
      if (decision === "denied" && fallbackPeople.some(person => {
        const latestPerson = this.store.resources.find<Person, PersonStatus>(person, person.metadata.name, person.metadata.namespace);
        return !latestPerson || latestPerson.metadata.uid !== person.metadata.uid || latestPerson.metadata.deletionTimestamp || !isMe(latestPerson.spec, this.ports.marks);
      })) throw new Error("Me identity changed before fallback commit");
      if (latest.status.attempts > 0 && !isDeepStrictEqual(receiverIdentity(latest.status.delivery), receiverIdentity(delivery))) {
        this.store.uncertain(id, "Actual recipients changed after a send attempt; verify external receipts"); return;
      }
      this.store.update(id, status => ({ ...status, disclosure: { decision, reason: reason || "Destination is permitted", checkedAt: new Date().toISOString(), fingerprint: snapshot.fingerprint, ...(snapshot.policy ? { policy: snapshot.policy } : {}) }, delivery,
        lastError: undefined }));
    });
    this.log.info({ outputId: id, decision, actualTarget: delivery.target }, "Output disclosure resolved");
  }
}

/** @spec Delivery timing is not disclosure permission; editing it cannot invalidate an attempted Output's authorization. */
function personDisclosure(person: Person) {
  const { delivery: _delivery, ...disclosure } = person;
  return disclosure;
}
