import { createHash } from "node:crypto";
import type { Address, Resource, ResourceRef } from "@compforge/aide-plugin";
import type { Logger } from "pino";
import { isChannelAddress } from "../../../src/channel/address.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { NOTE_TYPE, noteVersion, type NoteResource } from "../note/model.ts";
import { isMe, type Me, type PersonResource, type Person, type PersonStatus } from "../person/model.ts";
import { sensitivityRank, type MaterialDisclosure } from "../disclosure.ts";
import type { TopicSpec, TopicStatus } from "../topic/model.ts";
import type { Output } from "./model.ts";
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
type Material = MaterialDisclosure & { text: string; people?: ResourceRef[] };

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
  private snapshot(output: Output, audience: OutputAudience) {
    const dependencies: unknown[] = [];
    const materials: DisclosureEvidence["materials"] = [];
    let refusal = audience.complete && audience.people.length ? "" : "Cannot establish the complete destination audience";
    const get = <S, T>(ref: ResourceRef & { uid?: string }): Resource<S, T> | undefined => {
      const r = this.store.resources.find<S, T>(ref, ref.name, ref.namespace);
      dependencies.push([ref, r && [r.metadata.uid, r.metadata.deletionTimestamp, r.spec]]);
      return r && r.metadata.uid === ref.uid && !r.metadata.deletionTimestamp ? r : undefined;
    };
    const livePeople = audience.people.map(p => get<Person, PersonStatus>({ apiVersion: p.apiVersion, kind: p.kind, namespace: p.metadata.namespace, name: p.metadata.name, uid: p.metadata.uid }));
    if (livePeople.some(p => !p)) refusal ||= "Destination Person changed or was deleted";
    audience = { ...audience, complete: audience.complete && livePeople.every(Boolean), people: livePeople.filter((p): p is PersonResource => !!p) };
    const assess = (id: string, material: Material) => {
      materials.push({ id, text: material.text });
      const visibility = material.visibility ?? "people";
      let people = material.people ?? [];
      if (visibility === "topic" || visibility === "root") {
        const scope = material.disclosureScope && get<TopicSpec, TopicStatus>(material.disclosureScope);
        if (!scope) { refusal ||= `${id}: disclosure scope is missing or no longer exists`; return; }
        people = scope.spec.people ?? [];
      }
      for (const recipient of audience.people) {
        if (isMe(recipient.spec, this.ports.marks)) continue;
        if (sensitivityRank(material.sensitivity ?? "L3") > sensitivityRank(recipient.spec.clearance ?? "L1"))
          refusal ||= `${id}: sensitivity ${material.sensitivity ?? "L3"} exceeds ${recipient.metadata.name}'s clearance ${recipient.spec.clearance ?? "L1"}`;
        if (visibility !== "any" && !people.some(p => p.uid === recipient.metadata.uid))
          refusal ||= `${id}: recipient ${recipient.metadata.name} is outside visibility ${visibility}`;
      }
    };
    for (const ref of output.spec.notes ?? []) {
      const note = this.store.resources.page<NoteResource["spec"], NoteResource["status"]>(NOTE_TYPE, { namespace: "v1", limit: 1, matchIndex: { name: "uid", value: ref.uid } }).items[0];
      dependencies.push([ref, note && [note.metadata.uid, note.metadata.deletionTimestamp, note.spec, note.status.updatedAt]]);
      if (!note || note.metadata.deletionTimestamp || noteVersion(note) !== ref.version) { refusal ||= `Note ${ref.uid} is missing or changed since generation`; continue; }
      assess(ref.uid, note.spec);
    }
    for (const name of output.spec.inputIds ?? []) {
      const input = get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name, uid: output.spec.inputUids?.[name] });
      if (!input) { refusal ||= `Input ${name} is missing or replaced`; continue; }
      assess(name, { ...input.spec, people: [...(input.spec.sender ? [input.spec.sender] : []), ...input.spec.receivers ?? []] });
    }
    if (!materials.length) refusal ||= "No verifiable material references; cannot establish disclosure permission";
    const privateMe = audience.complete && audience.private && audience.people.length === 1 && isMe(audience.people[0]!.spec, this.ports.marks);
    return { fingerprint: hash([output.spec, dependencies, { ...audience, people: audience.people.map(p => [p.metadata.uid, p.metadata.deletionTimestamp, p.spec]) }, this.ports.marks]), privateMe,
      refusal: privateMe ? "" : refusal, evidence: { text: output.spec.text, materials } };
  }
  private async run(id: string) {
    const output = this.store.get(id);
    if (!output || output.metadata.deletionTimestamp || ["delivered", "failed", "uncertain"].includes(output.status.phase)) return;
    // A refused Output has only a Me delivery left. Permission changes never silently resurrect its original intent.
    if (output.status.disclosure?.decision === "denied" && output.status.delivery) {
      const audience = await this.ports.audience(output.status.delivery.target);
      if (!audience.complete || !audience.private || audience.people.length !== 1 || !isMe(audience.people[0]!.spec, this.ports.marks))
        throw new Error("Saved fallback destination is no longer a verified private Me channel");
      return;
    }
    let audience: OutputAudience;
    try { audience = await this.ports.audience(output.spec.target); }
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
    let delivery: NonNullable<Output["status"]["delivery"]> = { target: output.spec.target, text: output.spec.text, receivers: audience.people.map(p => ({ apiVersion: p.apiVersion, kind: p.kind, namespace: p.metadata.namespace, name: p.metadata.name, uid: p.metadata.uid })) };
    if (reason) {
      this.store.update(id, status => ({ ...status, delivery: undefined, disclosure: { decision: "denied", reason, checkedAt: new Date().toISOString(), fingerprint: snapshot.fingerprint } }));
      const me = await this.ports.contactMe(output.spec.topicId);
      const fallback = await this.ports.audience(me.target);
      if (!fallback.complete || !fallback.private || fallback.people.length !== 1 || !isMe(fallback.people[0]!.spec, this.ports.marks)) throw new Error("Default Channel is not a verified private Me destination");
      fallbackPeople = fallback.people;
      delivery = { ...me, text: `原计划发送至：${JSON.stringify(output.spec.target)}\n接收者：${JSON.stringify(output.spec.receivers ?? [])}\n未发送原因：${reason}\n\n原文：\n${output.spec.text}` };
    }
    // Awaited model/provider calls cannot authorize a changed resource or audience.
    let currentAudience: OutputAudience;
    try { currentAudience = await this.ports.audience(output.spec.target); }
    catch { currentAudience = { people: [], complete: false, private: false }; }
    this.store.storage.transaction(() => {
      const latest = this.store.get(id);
      if (!latest || latest.status.phase !== "pending") return;
      if (this.snapshot(latest, currentAudience).fingerprint !== snapshot.fingerprint) throw new Error("Disclosure dependencies changed during review; retry with current evidence");
      if (decision === "denied" && fallbackPeople.some(person => {
        const latestPerson = this.store.resources.find<Person, PersonStatus>(person, person.metadata.name, person.metadata.namespace);
        return !latestPerson || latestPerson.metadata.uid !== person.metadata.uid || latestPerson.metadata.deletionTimestamp || !isMe(latestPerson.spec, this.ports.marks);
      })) throw new Error("Me identity changed before fallback commit");
      const web = isChannelAddress(delivery.target) && delivery.target.channelId === "web";
      this.store.update(id, status => ({ ...status, disclosure: { decision, reason: reason || "Destination is permitted", checkedAt: new Date().toISOString(), fingerprint: snapshot.fingerprint }, delivery,
        ...(web ? { phase: "delivered", deliveredAt: new Date().toISOString() } : {}), lastError: undefined }));
    });
    this.log.info({ outputId: id, decision, actualTarget: delivery.target }, "Output disclosure resolved");
  }
}
