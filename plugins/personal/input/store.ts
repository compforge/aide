import { cloneResourceValue } from "../../../src/resource/value.ts";
import { ResourceAlreadyExists } from "@compforge/aide-plugin";
import { inputStatus } from "../status.ts";
import { PluginResourceStore } from "../../../src/host/plugin/resource/store.ts";
import { InputDefinition, InputSpecSchema } from "./definition.ts";
import { createHash } from "node:crypto";
import { ResourceStorage } from "../../../src/host/resource/storage.ts";
import { equalResourceValue } from "../../../src/resource/value.ts";
import { type Resource } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "./model.ts";
/** @spec Input facts are immutable and read on demand; shared ResourceStorage owns quotas and collection. */
export class InputStore {
  readonly storage: ResourceStorage;
  readonly resources: PluginResourceStore;
  key(id: string): string { return this.resources.key(INPUT_TYPE, id); }
  private readonly listeners = new Set<(owner: string, input: Resource<InputSpec, InputStatus>) => void>();
  constructor(home: string) {
    this.storage = ResourceStorage.open(home);
    this.storage.register("personal", [InputDefinition]);
    this.resources = new PluginResourceStore({ home: this.storage.home, pluginInstanceId: "personal" });
  }

  list(owner?: string, options: { limit?: number; after?: string } = {}): Resource<InputSpec, InputStatus>[] {
    const results: Resource<InputSpec, InputStatus>[] = [];
    let after = !options.after;
    for (const key of this.storage.keys("personal", this.key(""), true)) {
      if (!after) { if (key === this.key(options.after!)) after = true; continue; }
      const stored = this.storage.read(key)!;
      if (!owner || stored.owner === owner) results.push(stored.object as Resource<InputSpec, InputStatus>);
      if (options.limit && results.length >= options.limit) break;
    }
    return results;
  }
  query(name: string, value: string): Resource<InputSpec, InputStatus>[] {
    return [...this.storage.indexedKeys("personal", INPUT_TYPE, this.key(""), name, value)]
      .map(key => this.storage.read(key)!.object as Resource<InputSpec, InputStatus>);
  }
  receipt(id: string): { at: string; fingerprint: string } | undefined {
    const value = this.storage.receipt(`input:${id}`);
    return value ? JSON.parse(value) : undefined;
  }
  get(id: string): Resource<InputSpec, InputStatus> | undefined { return this.storage.read(this.key(id), true)?.object as Resource<InputSpec, InputStatus> | undefined; }
  submit(owner: string, id: string, raw: InputSpec, status: InputStatus = {}): Resource<InputSpec, InputStatus> {
    const spec = InputSpecSchema.parse(raw);
    const key = this.key(id), existing = this.storage.read(key);
    if (existing) {
      if (existing.owner !== owner || !equalResourceValue(existing.object.spec, spec)) throw new ResourceAlreadyExists("Input identity already exists with different content or owner");
      return existing.object as Resource<InputSpec, InputStatus>;
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({ owner, spec }, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest("hex");
    const receipt = this.receipt(id);
    if (receipt && receipt.fingerprint !== fingerprint) throw new ResourceAlreadyExists("Input identity already exists with different content or owner");
    const resource: Resource<InputSpec, InputStatus> = { ...INPUT_TYPE, metadata: { name: id, namespace: "v1", uid: `input:${id}`,
      resourceVersion: "1", generation: 1, creationTimestamp: receipt?.at ?? new Date().toISOString() }, spec, status: receipt ? { route: { completedAt: receipt.at, result: { topics: [], reason: "Previously accepted Input has expired" } } } : inputStatus(status) };
    // A bounded receipt acknowledges redelivery without recreating a collected fact or waking consumers.
    if (receipt) return resource;
    this.storage.write(key, "personal", { owner, object: resource, control: {} }, { key: `input:${id}`, value: JSON.stringify({ at: resource.metadata.creationTimestamp, fingerprint }) });
    this.notify(owner, resource); return resource;
  }
  update(resource: Resource<InputSpec, InputStatus>, patch: Partial<InputStatus>): Resource<InputSpec, InputStatus> {
    const key = this.key(resource.metadata.name), stored = this.storage.read(key);
    if (!stored || stored.object.metadata.uid !== resource.metadata.uid || stored.object.metadata.resourceVersion !== resource.metadata.resourceVersion) throw new Error("Input resource version conflict; read it again");
    const next = { ...resource, metadata: { ...resource.metadata, resourceVersion: String(Number(resource.metadata.resourceVersion) + 1) }, status: inputStatus({ ...resource.status, ...cloneResourceValue(patch) }) };
    this.storage.write(key, "personal", { ...stored, object: next }); this.notify(stored.owner as string, next); return next;
  }
  subscribe(listener: (owner: string, input: Resource<InputSpec, InputStatus>) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(owner: string, input: Resource<InputSpec, InputStatus>): void {
    this.storage.afterCommit(() => { for (const listener of this.listeners) listener(owner, cloneResourceValue(input)); });
  }
}
