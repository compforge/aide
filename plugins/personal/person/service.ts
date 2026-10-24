import { createHash } from "node:crypto";
import type { ResourceClient } from "@compforge/aide-plugin";
import { mergePersonSummary } from "./merge.ts";
import { IdentitySchema, PersonSchema, PERSON_TYPE, identityKey, isMe, LOCAL_ME, type Me, type Person, type PersonIdentity, type PersonResource, type PersonStatus } from "./model.ts";

/**
 * @spec Every topic resolves people in one catalog. Profiles contain no Input references.
 * @spec Matching uses scoped identifiers, never names; merging is an explicit user decision.
 * @link docs/personal/person.md
 */
export class Persons {
  constructor(private readonly resources: ResourceClient, readonly marks: Me) {}
  async list() {
    return (await this.resources.list<Person, PersonStatus>(PERSON_TYPE))
      .filter((p) => !p.metadata.deletionTimestamp).map((p) => ({ ...p, isMe: isMe(p.spec, this.marks) }));
  }
  async read(id: string, uid?: string) {
    const person = await this.resources.get<Person, PersonStatus>({ ...PERSON_TYPE, namespace: "v1", name: id });
    if (!person || person.metadata.deletionTimestamp || (uid !== undefined && person.metadata.uid !== uid)) throw new Error(`Unknown Person: ${id}`);
    return { ...person, isMe: isMe(person.spec, this.marks) };
  }
  /** @spec Me marks resolve existing identity owners; configuration never merges Person records.
   * @link docs/personal/person.md#身份me-与关系
   */
  async initialize() {
    for (const identity of this.marks.identities) {
      await this.observe(identity, identityKey(identity) === identityKey(LOCAL_ME) ? "我" : undefined);
    }
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
      spec: PersonSchema.parse({ name: name || identity.id, identities: [identity] }), status: { ...this.status("connector"), summary: "", recent: [] } }); }
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
    const status = { ...current.status, ...this.status("user") };
    if (summary !== undefined && summary !== current.status.summary) {
      status.summary = summary;
      status.recent = [...status.recent, { at: status.updatedAt, text: "用户修订了当前认识。" }];
    }
    return this.resources.replace(current, PersonSchema.parse(spec), status);
  }
  async summarize(id: string, uid: string, version: string, summary: string, recent: string) {
    const current = await this.version(id, uid, version);
    return this.resources.replace(current, current.spec, { ...current.status, ...this.status("chief"), summary,
      recent: [...current.status.recent, { at: new Date().toISOString(), text: recent }] });
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
    const [, merged] = await this.resources.commit([
      // Exclude the retiring identity owner before validating the target, within the same transaction.
      { operation: "delete", resource: from },
      { operation: "replace", resource: into, spec: PersonSchema.parse({ ...into.spec, identities }), status: {
        ...status, summary: summary ?? mergePersonSummary(into.status.summary, from.status.summary),
        recent: [...into.status.recent, ...from.status.recent].sort((a, b) => a.at.localeCompare(b.at))
          .concat({ at: status.updatedAt, text: `用户确认同一人，合并了「${from.spec.name}」（${from.metadata.name}）。` }),
      } },
    ]);
    const person = merged as PersonResource;
    return { ...person, isMe: isMe(person.spec, this.marks) };
  }
  async findIdentity(identity: PersonIdentity) {
    return (await this.list()).find((p) => p.spec.identities.some((i) => identityKey(i) === identityKey(identity)));
  }
  private async version(id: string, uid: string, version: string) {
    const current = await this.read(id);
    if (current.metadata.uid !== uid || current.metadata.resourceVersion !== version) throw new Error("Person resource version conflict; read it again before editing");
    return current;
  }
  private status(updatedBy: PersonStatus["updatedBy"]) { return { updatedAt: new Date().toISOString(), updatedBy }; }
}

export interface PersonVersion { id: string; uid: string; version: string }
