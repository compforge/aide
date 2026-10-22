import { PluginResourceStore } from "../../../src/host/plugin/resource/store.ts";
import { InputDefinition, InputSpecSchema } from "./definition.ts";
import { createHash } from "node:crypto";
import { ResourceStorage, resourceHome } from "../../../src/host/resource/storage.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { type Resource } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "./model.ts";
const State = z.array(z.object({ id: z.string(), owner: z.string(), at: z.string(), revision: z.number(), spec: InputSpecSchema,
  status: z.record(z.string(), z.unknown()) }));
/** @spec Input facts are immutable and read on demand; shared ResourceStorage owns quotas and collection. */
export class InputStore {
  readonly storage: ResourceStorage;
  readonly resources: PluginResourceStore;
  key(id: string): string { return this.resources.key(INPUT_TYPE, id); }
  private readonly listeners = new Set<(owner: string, input: Resource<InputSpec, InputStatus>) => void>();
  constructor(private readonly dir: string) {
    this.storage = ResourceStorage.open(resourceHome(dir));
    this.storage.register("personal", [InputDefinition]);
    this.resources = new PluginResourceStore({ home: this.storage.home, pluginInstanceId: "personal" });
    this.storage.migrate(join(dir, "inputs.json"), function* () {
      const path = join(dir, "inputs.json");
      if (!existsSync(path)) return;
      for (const i of State.parse(JSON.parse(readFileSync(path, "utf8")))) {
        yield [new PluginResourceStore({ home: dir, pluginInstanceId: "personal" }).key(INPUT_TYPE, i.id), JSON.stringify([null, "personal"]), { owner: i.owner, control: {}, object: { ...INPUT_TYPE,
          metadata: { name: i.id, namespace: "v1", uid: `input:${i.id}`, resourceVersion: String(i.revision), generation: 1, creationTimestamp: i.at },
          spec: i.spec, status: i.status } }];
      }
    });
  }
  list(owner?: string, options: { limit?: number; after?: string } = {}): Resource<InputSpec, InputStatus>[] {
    const results: Resource<InputSpec, InputStatus>[] = [];
    let after = !options.after;
    for (const key of this.storage.keys(JSON.stringify([null, "personal"]), this.key("").slice(0, -5), true)) {
      if (!after) { if (key === this.key(options.after!)) after = true; continue; }
      const stored = this.storage.read(key)!;
      if (!owner || stored.owner === owner) results.push(stored.object as Resource<InputSpec, InputStatus>);
      if (options.limit && results.length >= options.limit) break;
    }
    return results;
  }
  receipt(id: string): { at: string; fingerprint: string } | undefined {
    const value = this.storage.receipt(`input:${id}`);
    return value ? JSON.parse(value) : undefined;
  }
  get(id: string): Resource<InputSpec, InputStatus> | undefined { return this.storage.read(this.key(id), true)?.object as Resource<InputSpec, InputStatus> | undefined; }
  submit(owner: string, id: string, raw: InputSpec): Resource<InputSpec, InputStatus> {
    const spec = InputSpecSchema.parse(raw);
    const key = this.key(id), existing = this.storage.read(key);
    if (existing) {
      if (existing.owner !== owner || !isDeepStrictEqual(existing.object.spec, spec)) throw new Error("Input identity already exists with different content or owner");
      return existing.object as Resource<InputSpec, InputStatus>;
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({ owner, spec }, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest("hex");
    const receipt = this.receipt(id);
    if (receipt && receipt.fingerprint !== fingerprint) throw new Error("Input identity already exists with different content or owner");
    const resource: Resource<InputSpec, InputStatus> = { ...INPUT_TYPE, metadata: { name: id, namespace: "v1", uid: `input:${id}`,
      resourceVersion: "1", generation: 1, creationTimestamp: receipt?.at ?? new Date().toISOString() }, spec, status: receipt ? { routing: { phase: "ignored", reason: "Previously accepted Input has expired" } } : {} };
    // A bounded receipt acknowledges redelivery without recreating a collected fact or waking consumers.
    if (receipt) return resource;
    this.storage.write(key, JSON.stringify([null, "personal"]), { owner, object: resource, control: {} }, { key: `input:${id}`, value: JSON.stringify({ at: resource.metadata.creationTimestamp, fingerprint }) });
    this.notify(owner, resource); return resource;
  }
  update(resource: Resource<InputSpec, InputStatus>, patch: Partial<InputStatus>): Resource<InputSpec, InputStatus> {
    const key = this.key(resource.metadata.name), stored = this.storage.read(key);
    if (!stored || stored.object.metadata.uid !== resource.metadata.uid || stored.object.metadata.resourceVersion !== resource.metadata.resourceVersion) throw new Error("Input resource version conflict; read it again");
    const next = { ...resource, metadata: { ...resource.metadata, resourceVersion: String(Number(resource.metadata.resourceVersion) + 1) }, status: { ...resource.status, ...structuredClone(patch) } };
    this.storage.write(key, JSON.stringify([null, "personal"]), { ...stored, object: next }); this.notify(stored.owner as string, next); return next;
  }
  subscribe(listener: (owner: string, input: Resource<InputSpec, InputStatus>) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(owner: string, input: Resource<InputSpec, InputStatus>): void {
    this.storage.afterCommit(() => { for (const listener of this.listeners) listener(owner, structuredClone(input)); });
  }
}
