import { parseResourceNamespace } from "../plugin/namespace.ts";
import { AddressSchema } from "../../address.ts";
import { isChannelAddress } from "../../channel/address.ts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { OUTPUT_TYPE, type Output, type OutputSpec, type OutputStatus, type ResourceListOptions } from "@compforge/aide-plugin";
import { ResourceStorage } from "../resource/storage.ts";

const ref = z.object({ apiVersion: z.string().min(1), kind: z.string().min(1), namespace: z.string().min(1), name: z.string().min(1),
  uid: z.string().optional(), sessionId: z.string().optional() }).strict();
export const OutputSpecSchema = z.object({
  text: z.string().min(1).max(128_000),
  target: AddressSchema,
  receivers: z.array(ref.extend({ kind: z.literal("Person"), namespace: z.string().transform(parseResourceNamespace), uid: z.string().min(1) })).max(100).optional(),
  conversation: ref.extend({ uid: z.string().min(1) }), conversationId: z.string().min(1),
  executionId: z.string().optional(), producer: ref.optional(), inputIds: z.array(z.string().min(1)).max(1001).optional(),
}).strict();
const statusSchema = z.object({ phase: z.enum(["pending", "sending", "delivered", "failed", "uncertain"]), attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.iso.datetime().optional(), deliveredAt: z.iso.datetime().optional(), lastError: z.string().max(4000).optional() }).strict();

/** @spec Output is independent of Input and Conversation lifetime. Associations are provenance, not retention edges.
 * @spec Content, receivers and target never change after admission. Only the Host transport updates delivery state.
 * @link docs/output.md
 */
export class OutputStore {
  readonly storage: ResourceStorage;
  private readonly listeners = new Set<(output: Output) => void>();
  constructor(home: string) {
    this.storage = ResourceStorage.open(home);
    this.storage.register("core", { resourceType: OUTPUT_TYPE,
      releasedAt: (r) => (r.status as OutputStatus).phase === "delivered" ? (r.status as OutputStatus).deliveredAt
        : (r.status as OutputStatus).phase === "failed" ? new Date(Date.parse(r.metadata.creationTimestamp) + 7 * 86400_000).toISOString() : undefined,
      references: () => [] });
    this.storage.db.exec(`CREATE INDEX IF NOT EXISTS output_conversation ON resources(json_extract(data,'$.object.spec.conversation.uid')) WHERE kind='aide.dev/Output';
      CREATE INDEX IF NOT EXISTS output_execution ON resources(json_extract(data,'$.object.spec.executionId')) WHERE kind='aide.dev/Output';`);
  }
  get(id: string): Output | undefined { return this.storage.read(`output:${id}`, true)?.object as Output | undefined; }
  list(options: { owner?: string; conversationUid?: string; executionId?: string; after?: string; limit?: number; matchLabels?: ResourceListOptions["matchLabels"] } = {}): Output[] {
    const clauses = ["kind='aide.dev/Output'"];
    const args: string[] = [];
    for (const [path, value] of [["$.owner", options.owner], ["$.object.spec.conversation.uid", options.conversationUid], ["$.object.spec.executionId", options.executionId]] as const) {
      if (value !== undefined) { clauses.push(`json_extract(data,'${path}')=?`); args.push(value); }
    }
    if (options.after) { clauses.push("key>?"); args.push(`output:${options.after}`); }
    const rows = this.storage.db.prepare(`SELECT data FROM resources WHERE ${clauses.join(" AND ")} ORDER BY key`);
    const result: Output[] = [];
    for (const row of rows.iterate(...args)) {
      const output = JSON.parse(row.data as string).object as Output;
      if (Object.entries(options.matchLabels ?? {}).some(([k, v]) => output.metadata.labels?.[k] !== v)) continue;
      result.push(output); if (options.limit && result.length >= options.limit) break;
    }
    return result;
  }
  create(owner: string, id: string, raw: OutputSpec): Output {
    if (!id || id.length > 200) throw new Error("Invalid Output ID");
    const spec = OutputSpecSchema.parse(raw) as OutputSpec;
    const key = `output:${id}`, previous = this.storage.read(key);
    if (previous) {
      if (previous.owner !== owner || !isDeepStrictEqual(previous.object.spec, spec)) throw new Error("Output identity already exists with different content or owner");
      return previous.object as Output;
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({ owner, spec }, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest("hex");
    const receipt = this.storage.receipt(key);
    if (receipt) {
      const saved = JSON.parse(receipt);
      if (saved.fingerprint !== fingerprint) throw new Error("Output identity already exists with different content or owner");
      throw new Error("Output was already created and reclaimed; do not recreate delivery");
    }
    // Preserve admission order even for same-ms outputs and after restart.
    const latest = this.storage.db.prepare("SELECT max(created) AS at FROM resources WHERE kind='aide.dev/Output'").get()?.at as string | null;
    const at = new Date(Math.max(Date.now(), latest ? Date.parse(latest) + 1 : 0)).toISOString();
    const output: Output = { ...OUTPUT_TYPE, metadata: { name: id, uid: key, namespace: "aide-system", sessionId: owner,
      creationTimestamp: at, resourceVersion: "1", generation: 1,
      labels: { "aide.dev/conversation-uid": spec.conversation.uid, ...(spec.executionId ? { "aide.dev/execution-id": spec.executionId } : {}) } }, spec,
      status: isChannelAddress(spec.target) && spec.target.channelId === "web" ? { phase: "delivered", attempts: 0, deliveredAt: new Date().toISOString() } : { phase: "pending", attempts: 0 } };
    this.storage.write(key, "core", { owner, object: output }, { key, value: JSON.stringify({ fingerprint }) });
    this.notify(output); return output;
  }
  update(id: string, change: (current: OutputStatus) => OutputStatus): void {
    this.storage.transaction(() => {
      const stored = this.storage.read(`output:${id}`); if (!stored) throw new Error(`Output missing: ${id}`);
      const output = stored.object as Output;
      const status = statusSchema.parse(change(output.status));
      if (isDeepStrictEqual(status, output.status)) return;
      const next: Output = { ...output, metadata: { ...output.metadata, resourceVersion: String(Number(output.metadata.resourceVersion) + 1) }, status };
      this.storage.write(`output:${id}`, "core", { ...stored, object: next }); this.notify(next);
    });
  }
  begin(id: string): void { this.update(id, (s) => {
    if (s.phase === "delivered") return s;
    if (!["pending", "sending"].includes(s.phase)) throw new Error("Output requires explicit delivery recovery");
    return { phase: "sending", attempts: s.attempts + 1 };
  }); }
  delivered(id: string): void { this.update(id, (s) => s.phase === "delivered" ? s : { phase: "delivered", attempts: s.attempts, deliveredAt: new Date().toISOString() }); }
  retry(id: string, error: string, nextAttemptAt: string): void { this.update(id, (s) => s.phase === "delivered" ? s : { phase: "pending", attempts: s.attempts, lastError: error.slice(0, 4000), nextAttemptAt }); }
  subscribe(listener: (output: Output) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(output: Output): void { this.storage.afterCommit(() => { for (const listener of this.listeners) { try { listener(structuredClone(output)); } catch { /* persistence already committed */ } } }); }
}
