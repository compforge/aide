import { createHash } from "node:crypto";
import type { ResourceClient } from "@compforge/aide-plugin";
import { IdentitySchema, PersonSchema, PERSON_TYPE, identityKey, isMe, type Me, type Person, type PersonIdentity, type PersonResource, type PersonStatus } from "./model.ts";

/**
 * @spec Every conversation resolves people in one catalog. Profiles contain no Input references.
 * @spec Matching uses scoped identifiers, never names; profile edits cannot change identities or Me.
 * @link docs/plugin/personal.md
 */
export class Persons {
  constructor(private readonly resources: ResourceClient, readonly marks: Me) {}
  async list() {
    return (await this.resources.list<Person, PersonStatus>(PERSON_TYPE))
      .filter((p) => !p.metadata.deletionTimestamp).map((p) => ({ ...p, isMe: isMe(p.spec, this.marks) }));
  }
  async read(id: string) {
    const person = await this.resources.get<Person, PersonStatus>({ ...PERSON_TYPE, namespace: "v1", name: id });
    if (!person || person.metadata.deletionTimestamp) throw new Error(`Unknown Person: ${id}`);
    return { ...person, isMe: isMe(person.spec, this.marks) };
  }
  async me() {
    const matches = (await this.list()).filter((p) => p.isMe);
    if (matches.length > 1) throw new Error("Me identities match multiple Persons; correct the identity bindings");
    return matches[0];
  }
  async initialize() {
    const current = await this.me();
    if (!current) return this.resources.create(PERSON_TYPE, { name: "me",
      spec: PersonSchema.parse({ name: "我", identities: this.marks.identities }), status: { ...this.status("connector"), summary: "", recent: [] } });
    const identities = [...current.spec.identities];
    for (const identity of this.marks.identities) if (!identities.some((i) => identityKey(i) === identityKey(identity))) identities.push(identity);
    if (identities.length !== current.spec.identities.length) await this.resources.replace(current, { ...current.spec, identities }, { ...current.status, ...this.status("connector") });
    return current;
  }
  async observe(raw: PersonIdentity, name?: string): Promise<Readonly<PersonResource>> {
    const identity = IdentitySchema.parse(raw);
    const existing = (await this.list()).find((p) => p.spec.identities.some((i) => identityKey(i) === identityKey(identity)));
    if (existing) {
      // Fill an unresolved name only; connectors cannot overwrite user names or profiles.
      if (name && existing.spec.name === identity.id) {
        try { return await this.resources.replace(existing, { ...existing.spec, name: name.slice(0, 200) }, { ...existing.status, ...this.status("connector") }); }
        catch (error) { if (!String(error).includes("version conflict")) throw error; return this.read(existing.metadata.name); }
      }
      return existing;
    }
    const id = createHash("sha256").update(identityKey(identity)).digest("hex").slice(0, 32);
    try { return await this.resources.create(PERSON_TYPE, { name: id,
      spec: PersonSchema.parse({ name: name || identity.id, identities: [identity] }), status: { ...this.status("connector"), summary: "", recent: [] } }); }
    catch (error) { if (!String(error).includes("already exists")) throw error; return this.read(id); }
  }
  async edit(id: string, uid: string, version: string, spec: Person, summary?: string) {
    const current = await this.version(id, uid, version);
    // @spec User corrections replace the same summary Chief reads; stale writers must reread and merge.
    const status = { ...current.status, ...this.status("user") };
    if (summary !== undefined && summary !== current.status.summary) {
      status.summary = summary;
      status.recent = [...status.recent, { at: status.updatedAt, text: "用户修订了当前认识。" }];
    }
    return this.resources.replace(current, PersonSchema.parse(spec), status);
  }
  async profile(id: string, uid: string, version: string, summary: string, recent: string) {
    const current = await this.version(id, uid, version);
    return this.resources.replace(current, current.spec, { ...current.status, ...this.status("chief"), summary,
      recent: [...current.status.recent, { at: new Date().toISOString(), text: recent }] });
  }
  private async version(id: string, uid: string, version: string) {
    const current = await this.read(id);
    if (current.metadata.uid !== uid || current.metadata.resourceVersion !== version) throw new Error("Person resource version conflict; read it again before editing");
    return current;
  }
  private status(updatedBy: PersonStatus["updatedBy"]) { return { updatedAt: new Date().toISOString(), updatedBy }; }
}
