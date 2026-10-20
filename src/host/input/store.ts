import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { INPUT_TYPE, type InputSpec, type InputStatus, type Resource } from "@compforge/aide-plugin";
const Spec = z.object({ sessionId: z.string().min(1).max(200).optional(), origin: z.enum(["channel", "source"]),
  text: z.string().min(1).max(32_000), timezone: z.string().optional(), replyTo: z.string().optional(),
  observation: z.record(z.string(), z.unknown()).optional() }).strict();
const State = z.array(z.object({ id: z.string(), owner: z.string(), at: z.string(), revision: z.number(), spec: Spec,
  status: z.record(z.string(), z.unknown()) }));
/** @spec Inputs are independent host facts; one durable identity may be referenced by several plugin resources. */
export class InputStore {
  private state: z.infer<typeof State>;
  private readonly path: string;
  private readonly listeners = new Set<(owner: string, input: Resource<InputSpec, InputStatus>) => void>();
  constructor(private readonly dir: string) {
    this.path = join(dir, "inputs.json");
    this.state = existsSync(this.path) ? State.parse(JSON.parse(readFileSync(this.path, "utf8"))) : [];
  }
  list(owner?: string): Resource<InputSpec, InputStatus>[] { return this.state.filter((i) => !owner || i.owner === owner).map((i) => this.project(i)); }
  get(id: string): Resource<InputSpec, InputStatus> | undefined { const i = this.state.find((i) => i.id === id); return i && this.project(i); }
  submit(owner: string, id: string, raw: InputSpec): Resource<InputSpec, InputStatus> {
    const spec = Spec.parse(raw); const existing = this.state.find((i) => i.id === id);
    if (existing) { if (existing.owner !== owner || !isDeepStrictEqual(existing.spec, spec)) throw new Error("Input identity already exists with different content or owner"); return this.project(existing); }
    const input = { id, owner, at: new Date().toISOString(), revision: 1, spec, status: {} };
    this.commit([...this.state, input]); this.notify(input); return this.project(input);
  }
  update(resource: Resource<InputSpec, InputStatus>, patch: Partial<InputStatus>): Resource<InputSpec, InputStatus> {
    const current = this.state.find((i) => i.id === resource.metadata.name);
    if (!current || resource.metadata.uid !== `input:${current.id}` || resource.metadata.resourceVersion !== String(current.revision)) throw new Error("Input resource version conflict; read it again");
    const next = { ...current, revision: current.revision + 1, status: { ...current.status, ...structuredClone(patch) } };
    this.commit(this.state.map((i) => i.id === next.id ? next : i)); this.notify(next); return this.project(next);
  }
  subscribe(listener: (owner: string, input: Resource<InputSpec, InputStatus>) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private commit(state: z.infer<typeof State>): void {
    mkdirSync(this.dir, { recursive: true }); const tmp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); renameSync(tmp, this.path); this.state = state;
  }
  private notify(i: z.infer<typeof State>[number]): void { for (const listener of this.listeners) listener(i.owner, this.project(i)); }
  private project(i: z.infer<typeof State>[number]): Resource<InputSpec, InputStatus> {
    return structuredClone({ ...INPUT_TYPE, metadata: { name: i.id, namespace: "aide-system", uid: `input:${i.id}`,
      resourceVersion: String(i.revision), generation: 1, creationTimestamp: i.at }, spec: i.spec, status: i.status });
  }
}
