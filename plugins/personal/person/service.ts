import { isDeepStrictEqual } from "node:util";
import { sensitivityRank, type MaterialDisclosure } from "../disclosure.ts";
import { prepareSummary, readSummary, summaryView, writeSummary } from "../note/summary.ts";
import { contentVersion } from "../context-write.ts";
import { noteReference, type NoteStatus, type NoteSpec, type NoteReference } from "../note/model.ts";
import { createHash } from "node:crypto";
import type { ResourceClient } from "@compforge/aide-plugin";
import { pageNotes, readNotes } from "../note/query.ts";
import { SUMMARY_CHARS } from "../context.ts";
import { mergePersonSummary } from "./merge.ts";
import { IdentitySchema, PersonSchema, PERSON_TYPE, identityKey, isMe, LOCAL_ME, type Me, type Person, type PersonIdentity, type PersonResource, type PersonStatus } from "./model.ts";

/**
 * @spec Every topic resolves people in one catalog. Profiles contain no Input references.
 * @spec Matching uses scoped identifiers, never names; Me configuration or explicit user confirmation establishes shared identity.
 * @link docs/personal/person.md
 */
export class Persons {
  constructor(private readonly resources: ResourceClient, readonly marks: Me) {}
  async list() {
    return (await this.resources.list<Person, PersonStatus>(PERSON_TYPE))
      .filter((p) => !p.metadata.deletionTimestamp).map((p) => ({ ...p, isMe: isMe(p.spec, this.marks) }));
  }
  private async profile(id: string, uid?: string) {
    const person = await this.resources.get<Person, PersonStatus>({ ...PERSON_TYPE, namespace: "v1", name: id });
    if (!person || person.metadata.deletionTimestamp || (uid !== undefined && person.metadata.uid !== uid)) throw new Error(`Unknown Person: ${id}`);
    return person;
  }
  async notes(id: string, uid: string, continuation?: string) {
    const person = await this.profile(id, uid);
    return pageNotes(this.resources, person.metadata.uid, "people", continuation);
  }
  async read(id: string, uid?: string) {
    const person = await this.profile(id, uid);
    return { ...await summaryView(this.resources, person), recent: await readNotes(this.resources, person.metadata.uid, "people"), isMe: isMe(person.spec, this.marks) };
  }
  /** @spec Configured Me accounts identify one human; consolidate identity owners atomically before starting consumers.
   * @spec Preserve the local Me owner when present, otherwise the oldest matching Person. Repeated initialization is a no-op.
   * @link docs/personal/person.md#身份me-与关系
   * @case tests/person-merge.test.ts
   */
  async initialize(): Promise<{ merged: number; conflict?: { personIds: string[]; reason: string } }> {
    const marks = [...new Map(this.marks.identities.map(i => [identityKey(i), IdentitySchema.parse(i)])).values()];
    if (!marks.length) return { merged: 0 };
    const people = (await this.list()).filter(p => p.isMe).sort((a, b) =>
      a.metadata.creationTimestamp.localeCompare(b.metadata.creationTimestamp) || a.metadata.name.localeCompare(b.metadata.name));
    const local = identityKey(LOCAL_ME);
    const target = people.find(p => p.spec.identities.some(i => identityKey(i) === local)) ?? people[0];
    if (!target) {
      const identity = marks.find(i => identityKey(i) === local) ?? marks[0]!;
      await this.resources.create(PERSON_TYPE, {
        name: createHash("sha256").update(identityKey(identity)).digest("hex").slice(0, 32),
        spec: PersonSchema.parse({ name: "我", identities: marks }),
        status: { ...this.status("connector") },
      });
      return { merged: 0 };
    }
    const sources = people.filter(p => p.metadata.uid !== target.metadata.uid);
    const identities = [...new Map([...target.spec.identities, ...sources.flatMap(p => p.spec.identities), ...marks]
      .map(i => [identityKey(i), i])).values()];
    if (!sources.length && identities.length === target.spec.identities.length) return { merged: 0 };
    const texts = await Promise.all([target, ...sources].map(p => readSummary(this.resources, p)));
    const summary = texts.reduce((text, note) => mergePersonSummary(text, note?.spec.text ?? ""), "");
    // Configuration must not silently discard understanding or prevent startup when consolidation needs user editing.
    if (summary.length > SUMMARY_CHARS || identities.length > 100) return { merged: 0, conflict: {
      personIds: people.map(p => p.metadata.name),
      reason: summary.length > SUMMARY_CHARS ? "Combined Me summary exceeds the Person budget; consolidate the summaries before merging" : "Combined Me identities exceed the Person budget",
    } };
    const disclosure = mergeSummaryDisclosure(texts.flatMap(note => note?.spec.text ? [note.spec] : []));
    if (!disclosure) return { merged: 0, conflict: { personIds: people.map(p => p.metadata.name), reason: "Summary disclosure scopes differ; classify the summaries before merging" } };
    const status = this.status("connector");
    const prepared = await prepareSummary(this.resources, target, { text: summary, people: texts.flatMap(n => n?.spec.people ?? []), ...disclosure });
    await this.resources.commit([
      ...prepared.writes,
      ...sources.map(resource => ({ operation: "delete" as const, resource })),
      { operation: "replace", resource: target, spec: PersonSchema.parse({ ...target.spec, identities }), status: {
        ...status, ...prepared.status,
      } },
    ]);
    return { merged: sources.length };
  }
  async observe(raw: PersonIdentity, name?: string): Promise<Readonly<PersonResource>> {
    const identity = IdentitySchema.parse(raw);
    const existing = await this.findIdentity(identity);
    if (existing) {
      // Fill an unresolved name only; connectors cannot overwrite user names or profiles.
      if (name && existing.spec.name === identity.id) {
        try { return await this.resources.replace(existing, { ...existing.spec, name: name.slice(0, 200) }, { ...existing.status, ...this.status("connector") }); }
        catch (error) {
          if (!/version conflict|not found|incarnation changed/.test(String(error))) throw error;
          const current = await this.findIdentity(identity);
          if (!current) throw error;
          return current;
        }
      }
      return existing;
    }
    const id = createHash("sha256").update(identityKey(identity)).digest("hex").slice(0, 32);
    try { return await this.resources.create(PERSON_TYPE, { name: id,
      spec: PersonSchema.parse({ name: name || identity.id, identities: [identity] }), status: { ...this.status("connector") } }); }
    catch (error) {
      if (!/already exists|identity already belongs/.test(String(error))) throw error;
      // A concurrent merge may have transferred the identity since the initial lookup.
      const current = await this.findIdentity(identity);
      if (!current) throw error;
      return current;
    }
  }
  async edit(id: string, uid: string, version: string, spec: Person, summary?: string) {
    const current = await this.version(id, uid, version);
    const retained = new Set(spec.identities.map(identityKey));
    if (current.spec.identities.some(i => this.marks.identities.some(mark => identityKey(mark) === identityKey(i)) && !retained.has(identityKey(i))))
      throw new Error("A configured Me identity cannot be removed; change the Me configuration first or merge the Person");
    // @spec User corrections replace the same summary Chief reads; stale writers must reread and merge.
    const { contextWriter: _, ...previousStatus } = current.status;
    const status = { ...previousStatus, ...this.status("user") };
    const prepared = summary === undefined ? { note: undefined, writes: [], status: {} } : await prepareSummary(this.resources, current, { text: summary });
    const results = await this.resources.commit([...prepared.writes,
      { operation: "replace", resource: current, spec: PersonSchema.parse(spec), status: { ...status, ...prepared.status } }]);
    return this.view(results.at(-1) as PersonResource, summary ?? current.summaryText, noteReference(prepared.note) ?? current.summaryNote);
  }
  async summarize(id: string, uid: string, version: string, summary: string, writer?: NoteStatus["writer"], people?: NoteSpec["people"], disclosure?: import("../disclosure.ts").MaterialDisclosure) {
    const current = await this.read(id, uid);
    if (contentVersion(current) !== version) throw new Error("Person summary version conflict; read it again");
    const committed = await writeSummary(this.resources, current, { text: summary, people, ...disclosure }, writer, version, this.status("chief"));
    return this.view(committed, summary, committed.summaryNote);
  }

  /**
   * @spec Append to the target and delete the source atomically. Names never prove identity.
   * @spec Historical Input/Output references may dangle and are never rewritten by a merge.
   * @link docs/personal/person.md
   * @case tests/person-merge.test.ts
   */
  async merge(source: PersonVersion, target: PersonVersion, summary?: string) {
    if (source.id === target.id) throw new Error("Cannot merge a Person into itself");
    const [from, into] = await Promise.all([
      this.version(source.id, source.uid, source.version), this.version(target.id, target.uid, target.version),
    ]);
    const identities = [...new Map([...into.spec.identities, ...from.spec.identities].map((i) => [identityKey(i), i])).values()];
    const status = this.status("user");
    const mergedText = summary ?? mergePersonSummary(into.summaryText, from.summaryText);
    const disclosure = mergeSummaryDisclosure([into, from].flatMap(person => person.summaryText && person.summaryNote ? [person.summaryNote] : []));
    if (!disclosure) throw new Error("Summary disclosure scopes differ; classify the summaries before merging");
    const prepared = await prepareSummary(this.resources, into, { text: mergedText, people: [...into.summaryNote?.people ?? [], ...from.summaryNote?.people ?? []], ...disclosure });
    const writes = await this.resources.commit([
      ...prepared.writes,
      // Exclude the retiring identity owner before validating the target, within the same transaction.
      { operation: "delete", resource: from },
      { operation: "replace", resource: into, spec: PersonSchema.parse({ ...into.spec, identities }), status: {
        ...status, ...prepared.status,
      } },
    ]);
    const person = writes.at(-1) as PersonResource;
    return this.view(person, mergedText, noteReference(prepared.note));
  }
  private async view(person: PersonResource, summaryText: string, summaryNote?: NoteReference) {
    return { ...person, summaryText, summaryNote, summaryVersion: contentVersion(person),
      recent: await readNotes(this.resources, person.metadata.uid, "people"), isMe: isMe(person.spec, this.marks) };
  }
  async findIdentity(identity: PersonIdentity) {
    const person = (await this.resources.list<Person, PersonStatus>(PERSON_TYPE, { matchIndex: { name: "identity", value: identityKey(identity) } }))
      .find(p => !p.metadata.deletionTimestamp);
    return person ? { ...await summaryView(this.resources, person), isMe: isMe(person.spec, this.marks) } : undefined;
  }
  private async version(id: string, uid: string, version: string) {
    const current = await this.read(id);
    if (current.metadata.uid !== uid || current.metadata.resourceVersion !== version) throw new Error("Person resource version conflict; read it again before editing");
    return current;
  }
  private status(updatedBy: PersonStatus["updatedBy"]) { return { updatedAt: new Date().toISOString(), updatedBy }; }
}

export interface PersonVersion { id: string; uid: string; version: string }

/** @spec Identity consolidation cannot lower material sensitivity or silently combine different authorization scopes. */
function mergeSummaryDisclosure(materials: MaterialDisclosure[]): MaterialDisclosure | undefined {
  if (!materials.length) return {};
  const first = materials[0]!;
  if (materials.some(material => (material.visibility ?? "people") !== (first.visibility ?? "people")
    || !isDeepStrictEqual(material.disclosureScope, first.disclosureScope))) return;
  const sensitivity = materials.map(material => material.sensitivity ?? "L3")
    .reduce((a, b) => sensitivityRank(a) >= sensitivityRank(b) ? a : b);
  return { sensitivity, visibility: first.visibility ?? "people" };
}
