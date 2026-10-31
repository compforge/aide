import { cloneResourceValue, equalResourceValue } from "../../../src/resource-value.ts";
import { NOTE_TYPE, noteVersion, noteTextVersion, type NoteResource } from "../note/model.ts";
import { PluginResourceStore } from "../../../src/host/plugin/resource/store.ts";
import { OutputDefinition, OutputSpecSchema, OutputStatusSchema } from "./definition.ts";
export { OutputSpecSchema } from "./definition.ts";
import { assertChannelDelivery } from "../../../src/channel/address.ts";
import { createHash } from "node:crypto";
import { type Address, type ResourceListOptions } from "@compforge/aide-plugin";
import { OUTPUT_TYPE, receiverIdentity, type Output, type OutputSpec, type OutputStatus } from "./model.ts";
import { ResourceStorage } from "../../../src/host/resource/storage.ts";

// Derived citation fingerprints are evidence, not part of the caller's idempotent sending intent.
const outputIntent = (spec: OutputSpec) => ({ ...receiverIdentity(spec), notes: spec.notes?.map(({ uid, version }) => ({ uid, version })) });

/** @spec Output is independent of Input and Topic lifetime. Associations are provenance, not retention edges.
 * @spec Content, receivers and target never change after admission. The Output coordinator owns delivery state.
 * @link docs/personal/output.md
 */
export class OutputStore {
  readonly storage: ResourceStorage;
  readonly resources: PluginResourceStore;
  key(id: string): string { return this.resources.key(OUTPUT_TYPE, id); }
  check?: (id: string) => Promise<void>;
  async prepare(id: string): Promise<Output> {
    if (!this.check) throw new Error("Output disclosure checker is unavailable");
    await this.check(id);
    const output = this.get(id);
    if (!output?.status.delivery || !output.status.disclosure) throw new Error("Output disclosure is pending");
    return output;
  }
  private readonly listeners = new Set<(output: Output) => void>();
  constructor(home: string, private readonly validateTarget: (target: Address) => void = assertChannelDelivery) {
    this.storage = ResourceStorage.open(home);
    this.storage.register("personal", [OutputDefinition]);
    this.resources = new PluginResourceStore({ home: this.storage.home, pluginInstanceId: "personal" });
    this.storage.db.exec(`CREATE INDEX IF NOT EXISTS output_topic ON resources(json_extract(data,'$.object.spec.topic.uid')) WHERE kind='aide.dev/Output';
      CREATE INDEX IF NOT EXISTS output_execution ON resources(json_extract(data,'$.object.spec.executionId')) WHERE kind='aide.dev/Output';`);
  }
  get(id: string): Output | undefined { return this.storage.read(this.key(id), true)?.object as Output | undefined; }
  list(options: { owner?: string; topicUid?: string; executionId?: string; inputId?: string; after?: string; limit?: number; matchLabels?: ResourceListOptions["matchLabels"] } = {}): Output[] {
    const clauses = ["scope='personal'", "kind='aide.dev/Output'", "json_extract(data, '$.object.apiVersion')=?"];
    const args: string[] = [OUTPUT_TYPE.apiVersion];
    for (const [path, value] of [["$.owner", options.owner], ["$.object.spec.topic.uid", options.topicUid], ["$.object.spec.executionId", options.executionId]] as const) {
      if (value !== undefined) { clauses.push(`json_extract(data,'${path}')=?`); args.push(value); }
    }
    if (options.after) { clauses.push("key>?"); args.push(this.key(options.after)); }
    if (options.inputId !== undefined) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(data, '$.object.spec.inputIds') WHERE value=?)"); args.push(options.inputId);
    }
    const rows = this.storage.db.prepare(`SELECT data FROM resources WHERE ${clauses.join(" AND ")} ORDER BY key`);
    const result: Output[] = [];
    for (const row of rows.iterate(...args)) {
      const output = this.storage.decode("personal", row.data as string).object as Output;
      if (Object.entries(options.matchLabels ?? {}).some(([k, v]) => output.metadata.labels?.[k] !== v)) continue;
      result.push(output); if (options.limit && result.length >= options.limit) break;
    }
    return result;
  }
  create(owner: string, id: string, raw: OutputSpec): Output {
    if (!id || id.length > 200) throw new Error("Invalid Output ID");
    const spec = OutputSpecSchema.parse(JSON.parse(JSON.stringify(raw))) as OutputSpec;
    // Pin the cited body separately from mutable classification. Never trust a caller-supplied body fingerprint.
    if (spec.notes) spec.notes = spec.notes.map(({ uid, version }) => {
      const note = this.resources.page<NoteResource["spec"], NoteResource["status"]>(NOTE_TYPE, { namespace: "v1", limit: 1, matchIndex: { name: "uid", value: uid } }).items[0];
      return { uid, version, ...(note && noteVersion(note) === version ? { textVersion: noteTextVersion(note) } : {}) };
    });
    const key = this.key(id), previous = this.storage.read(key);
    if (previous) {
      if (previous.owner !== owner || !equalResourceValue(outputIntent(previous.object.spec as OutputSpec), outputIntent(spec))) throw new Error("Output identity already exists with different content or owner");
      return previous.object as Output;
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({ owner, spec: outputIntent(spec) }, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest("hex");
    const receipt = this.storage.receipt(`output:${id}`);
    if (receipt) {
      const saved = JSON.parse(receipt);
      if (saved.fingerprint !== fingerprint) throw new Error("Output identity already exists with different content or owner");
      throw new Error("Output was already created and reclaimed; do not recreate delivery");
    }
    this.validateTarget(spec.target);
    // Preserve admission order even for same-ms outputs and after restart.
    const latest = this.storage.db.prepare("SELECT max(created) AS at FROM resources WHERE kind='aide.dev/Output'").get()?.at as string | null;
    const at = new Date(Math.max(Date.now(), latest ? Date.parse(latest) + 1 : 0)).toISOString();
    const output: Output = { ...OUTPUT_TYPE, metadata: { name: id, uid: `output:${id}`, namespace: "v1",
      creationTimestamp: at, resourceVersion: "1", generation: 1,
      labels: { "aide.dev/topic-uid": spec.topic.uid, ...(spec.executionId ? { "aide.dev/execution-id": spec.executionId } : {}) } }, spec,
      status: { phase: "pending", attempts: 0 } };
    this.storage.write(key, "personal", { owner, object: output, control: {} }, { key: `output:${id}`, value: JSON.stringify({ fingerprint }) });
    this.notify(output); return output;
  }
  update(id: string, change: (current: OutputStatus) => OutputStatus): void {
    this.storage.transaction(() => {
      const stored = this.storage.read(this.key(id)); if (!stored) throw new Error(`Output missing: ${id}`);
      const output = stored.object as Output;
      const status = OutputStatusSchema.parse(change(output.status));
      if (equalResourceValue(status, output.status)) return;
      const next: Output = { ...output, metadata: { ...output.metadata, resourceVersion: String(Number(output.metadata.resourceVersion) + 1) }, status };
      this.storage.write(this.key(id), "personal", { ...stored, object: next }); this.notify(next);
    });
  }
  begin(id: string): void { this.update(id, (s) => {
    if (s.phase === "delivered") return s;
    if (!["pending", "sending"].includes(s.phase)) throw new Error("Output requires explicit delivery recovery");
    if (!s.disclosure || !s.delivery) throw new Error("Output disclosure has not been checked");
    return { ...s, phase: "sending", deliveryWait: undefined, lastError: undefined, attempts: s.attempts + 1 };
  }); }
  delivered(id: string, receipt?: OutputStatus["receipt"]): void { this.update(id, (s) => s.phase === "delivered" ? s : { ...s, phase: "delivered", deliveryWait: undefined, lastError: undefined, attempts: s.attempts, deliveredAt: new Date().toISOString(), ...(receipt ? { receipt } : {}) }); }
  uncertain(id: string, error: string): void { this.update(id, (s) => s.phase === "delivered" ? s : { ...s, phase: "uncertain", lastError: error.slice(0, 4000) }); }
  retry(id: string, error: string): void { this.update(id, (s) => s.phase === "delivered" ? s : { ...s, phase: "pending", attempts: s.attempts, lastError: error.slice(0, 4000) }); }
  subscribe(listener: (output: Output) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(output: Output): void { this.storage.afterCommit(() => { for (const listener of this.listeners) { try { listener(cloneResourceValue(output)); } catch { /* persistence already committed */ } } }); }
}
