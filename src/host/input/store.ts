import { AddressSchema } from "../../address.ts";
import { createHash } from "node:crypto";
import { ResourceStorage } from "../resource/storage.ts";
import { parseResourceNamespace } from "../plugin/namespace.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { INPUT_TYPE, type InputSpec, type InputStatus, type Resource } from "@compforge/aide-plugin";
const Spec = z.object({ source: AddressSchema.optional(), sessionId: z.string().min(1).max(200).optional(), origin: z.enum(["channel", "source"]),
  originId: z.string().min(1), relation: z.enum(["sent", "received", "observed"]).optional(),
  sender: z.object({ apiVersion: z.string(), kind: z.literal("Person"), sessionId: z.string().optional(), namespace: z.string().transform(parseResourceNamespace), name: z.string(), uid: z.string() }).strict().optional(),
  attention: z.enum(["immediate", "deferred"]).optional(),
  originRef: z.object({ apiVersion: z.string(), kind: z.string(), namespace: z.string().transform((value) => value === "aide-system" ? value : parseResourceNamespace(value)), name: z.string(), uid: z.string(), sessionId: z.string().optional() }).strict().optional(),
  text: z.string().min(1).max(32_000), timezone: z.string().optional(), replyTo: z.string().optional(),
  observation: z.record(z.string(), z.unknown()).optional() }).strict();
const State = z.array(z.object({ id: z.string(), owner: z.string(), at: z.string(), revision: z.number(), spec: Spec,
  status: z.record(z.string(), z.unknown()) }));
/** @spec Input facts are immutable and read on demand; shared ResourceStorage owns quotas and collection. */
export class InputStore {
  readonly storage: ResourceStorage;
  private readonly listeners = new Set<(owner: string, input: Resource<InputSpec, InputStatus>) => void>();
  constructor(private readonly dir: string) {
    this.storage = ResourceStorage.open(dir);
    this.storage.register("core", { resourceType: INPUT_TYPE,
      releasedAt: (r) => ["done", "ignored"].includes((r.status as InputStatus).routing?.phase ?? "") ? r.metadata.creationTimestamp : undefined,
      references: () => [],
    });
    this.storage.migrate(join(dir, "inputs.json"), function* () {
      const path = join(dir, "inputs.json");
      if (!existsSync(path)) return;
      for (const i of State.parse(JSON.parse(readFileSync(path, "utf8")))) {
        yield [`input:${i.id}`, "core", { owner: i.owner, object: { ...INPUT_TYPE,
          metadata: { name: i.id, namespace: "aide-system", uid: `input:${i.id}`, resourceVersion: String(i.revision), generation: 1, creationTimestamp: i.at },
          spec: i.spec, status: i.status } }];
      }
    });
  }
  list(owner?: string, options: { limit?: number; after?: string } = {}): Resource<InputSpec, InputStatus>[] {
    const results: Resource<InputSpec, InputStatus>[] = [];
    let after = !options.after;
    for (const key of this.storage.keys("core", "input:", true)) {
      if (!after) { if (key === `input:${options.after}`) after = true; continue; }
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
  get(id: string): Resource<InputSpec, InputStatus> | undefined { return this.storage.read(`input:${id}`, true)?.object as Resource<InputSpec, InputStatus> | undefined; }
  submit(owner: string, id: string, raw: InputSpec): Resource<InputSpec, InputStatus> {
    const spec = Spec.parse(raw);
    const key = `input:${id}`, existing = this.storage.read(key);
    if (existing) {
      if (existing.owner !== owner || !isDeepStrictEqual(existing.object.spec, spec)) throw new Error("Input identity already exists with different content or owner");
      return existing.object as Resource<InputSpec, InputStatus>;
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({ owner, spec }, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest("hex");
    const receipt = this.receipt(id);
    if (receipt && receipt.fingerprint !== fingerprint) throw new Error("Input identity already exists with different content or owner");
    const resource: Resource<InputSpec, InputStatus> = { ...INPUT_TYPE, metadata: { name: id, namespace: "aide-system", uid: key,
      resourceVersion: "1", generation: 1, creationTimestamp: receipt?.at ?? new Date().toISOString() }, spec, status: receipt ? { routing: { phase: "ignored", reason: "Previously accepted Input has expired" } } : {} };
    // A bounded receipt acknowledges redelivery without recreating a collected fact or waking consumers.
    if (receipt) return resource;
    this.storage.write(key, "core", { owner, object: resource }, { key, value: JSON.stringify({ at: resource.metadata.creationTimestamp, fingerprint }) });
    this.notify(owner, resource); return resource;
  }
  update(resource: Resource<InputSpec, InputStatus>, patch: Partial<InputStatus>): Resource<InputSpec, InputStatus> {
    const key = `input:${resource.metadata.name}`, stored = this.storage.read(key);
    if (!stored || stored.object.metadata.uid !== resource.metadata.uid || stored.object.metadata.resourceVersion !== resource.metadata.resourceVersion) throw new Error("Input resource version conflict; read it again");
    const next = { ...resource, metadata: { ...resource.metadata, resourceVersion: String(Number(resource.metadata.resourceVersion) + 1) }, status: { ...resource.status, ...structuredClone(patch) } };
    this.storage.write(key, "core", { ...stored, object: next }); this.notify(stored.owner as string, next); return next;
  }
  subscribe(listener: (owner: string, input: Resource<InputSpec, InputStatus>) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(owner: string, input: Resource<InputSpec, InputStatus>): void { for (const listener of this.listeners) listener(owner, structuredClone(input)); }
}
