import { randomUUID } from "node:crypto";
import type { Stream, StreamRef, StreamEvent, StreamRecord, StreamReader, StreamReference, StreamStatus, ResourceOwnerReference } from "@compforge/aide-plugin";
import { STREAM_TYPE } from "@compforge/aide-plugin";
import { ResourceStorage } from "../resource/storage.ts";
import { PluginResourceStore } from "../plugin/resource/store.ts";
import { StreamDefinition, StreamStatusSchema } from "./definition.ts";

/** @spec Append batches and the durable tail commit atomically. Notifications are hints; readers resume by sequence.
 * @spec Terminal streams never reopen. Owner deletion removes content through the resource foreign key.
 * @link docs/plugin/stream.md
 * @case tests/stream.test.ts
 */
const closeReserveBytes = 2048;

export class StreamStore {
  readonly storage: ResourceStorage;
  readonly resources: PluginResourceStore;
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(home: string, readonly scope: string) {
    this.storage = ResourceStorage.open(home);
    this.storage.register(scope, [StreamDefinition]);
    this.resources = new PluginResourceStore({ home, pluginInstanceId: scope });
    this.storage.db.exec(`CREATE TABLE IF NOT EXISTS stream_records (
      uid TEXT NOT NULL REFERENCES resources(uid) ON DELETE CASCADE,
      seq INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(uid,seq));`);
  }
  reference(name: string, uid = `stream:${randomUUID()}`): StreamRef { return { ...STREAM_TYPE, namespace: "v1", name, uid }; }
  create(ref: StreamRef, owner: ResourceOwnerReference, protocol: string): Stream {
    return this.storage.transaction(() => this.createOwned(ref, owner, protocol));
  }
  private createOwned(ref: StreamRef, owner: ResourceOwnerReference, protocol: string): Stream {
    const key = this.resources.key(ref, ref.name, ref.namespace);
    const current = this.storage.read(key);
    if (current) {
      const stream = this.get(ref);
      if (stream.metadata.owner?.uid !== owner.uid || stream.spec.protocol !== protocol) throw new Error("Stream owner mismatch");
      return stream;
    }
    const parent = this.resources.get(owner, owner.name, owner.namespace);
    if (parent.metadata.uid !== owner.uid || parent.metadata.deletionTimestamp) throw new Error("Stream owner is unavailable");
    const stream: Stream = { ...STREAM_TYPE, metadata: { name: ref.name, namespace: owner.namespace, uid: ref.uid,
      owner, creationTimestamp: new Date().toISOString(), generation: 1, resourceVersion: "1" }, spec: { protocol }, status: { phase: "open", lastSeq: 0, references: [] } };
    this.storage.write(key, this.scope, { object: stream, control: {} });
    this.storage.db.prepare("INSERT INTO resource_payload_sizes VALUES (?,?)").run(ref.uid, closeReserveBytes);
    this.storage.write(key, this.scope, { object: stream, control: {} });
    return stream;
  }
  get(ref: StreamRef): Stream {
    const stream = this.storage.read(this.resources.key(ref, ref.name, ref.namespace))?.object as Stream | undefined;
    if (!stream || stream.metadata.uid !== ref.uid || stream.metadata.deletionTimestamp) throw new Error(`Stream unavailable: ${ref.uid}`);
    return stream;
  }
  append(ref: StreamRef, records: readonly StreamEvent[]): void {
    if (!records.length) return;
    this.change(ref, stream => {
      const insert = this.storage.db.prepare("INSERT INTO stream_records VALUES (?,?,?,?)");
      let bytes = 0;
      for (const record of records) {
        if (!record.kind || record.payload === undefined) throw new Error("Invalid Stream record");
        const payload = JSON.stringify(record.payload);
        if (payload === undefined) throw new Error("Stream payload must be JSON");
        insert.run(ref.uid, ++stream.status.lastSeq, record.kind, payload);
        bytes += Buffer.byteLength(record.kind) + Buffer.byteLength(payload);
      }
      this.storage.db.prepare("UPDATE resource_payload_sizes SET bytes=bytes+? WHERE uid=?").run(bytes, ref.uid);
    });
  }
  cite(ref: StreamRef, references: readonly StreamReference[]): void {
    if (!references.length) return;
    this.change(ref, stream => {
      const unique = new Map(stream.status.references.map(item => [JSON.stringify(item), item]));
      for (const item of references) unique.set(JSON.stringify(item), item);
      stream.status.references = [...unique.values()];
    });
  }
  complete(ref: StreamRef): void { this.finish(ref, "completed"); }
  interrupt(ref: StreamRef, reason: string): void { this.finish(ref, "interrupted", reason); }
  private finish(ref: StreamRef, phase: "completed" | "interrupted", error?: string) {
    const current = this.get(ref);
    if (current.status.phase === phase) return;
    this.change(ref, stream => {
      this.storage.db.prepare("UPDATE resource_payload_sizes SET bytes=bytes-? WHERE uid=?").run(closeReserveBytes, ref.uid);
      Object.assign(stream.status, { phase, closedAt: new Date().toISOString(), ...(error ? { error: error.slice(0, 256) } : {}) });
    });
  }
  private change(ref: StreamRef, apply: (stream: Stream) => void) {
    this.storage.transaction(() => {
      const stream = this.get(ref), owner = stream.metadata.owner!;
      const parent = this.resources.get(owner, owner.name, owner.namespace);
      if (parent.metadata.uid !== owner.uid || parent.metadata.deletionTimestamp) throw new Error("Stream owner is unavailable");
      if (stream.status.phase !== "open") throw new Error(`Stream is closed: ${ref.uid}`);
      apply(stream);
      const next = { ...stream, metadata: { ...stream.metadata, resourceVersion: String(Number(stream.metadata.resourceVersion) + 1) } };
      const key = this.resources.key(ref, ref.name, ref.namespace);
      this.storage.write(key, this.scope, { ...this.storage.read(key)!, object: next });
      this.storage.afterCommit(() => { for (const listener of this.listeners.get(ref.uid) ?? []) listener(); });
    });
  }
  read(ref: StreamRef, afterSeq = 0, limit = 256, throughSeq = this.get(ref).status.lastSeq): StreamRecord[] {
    this.get(ref);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1024) throw new Error("Invalid Stream cursor or page size");
    return this.storage.db.prepare("SELECT seq,kind,payload FROM stream_records WHERE uid=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?")
      .all(ref.uid, afterSeq, throughSeq, limit).map(row => ({ seq: Number(row.seq), kind: String(row.kind), payload: JSON.parse(String(row.payload)) }));
  }
  /** @spec A persisted snapshot can be reopened after append/close without exposing later records or terminal state.
   * @link docs/plugin/stream.md
   */
  reader(ref: StreamRef, snapshot?: StreamStatus): StreamReader {
    const stream = this.get(ref), status = StreamStatusSchema.parse(snapshot ?? stream.status), throughSeq = status.lastSeq;
    if (throughSeq > stream.status.lastSeq || (status.phase !== "open" && (status.phase !== stream.status.phase || throughSeq !== stream.status.lastSeq))) throw new Error("Stream snapshot is not committed");
    return { ref, protocol: stream.spec.protocol, status,
      read: (afterSeq = 0, limit = 256) => this.read(ref, afterSeq, limit, throughSeq) };
  }
  async wait(ref: StreamRef, afterSeq: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {};
      const cleanup = () => { unsubscribe(); clearInterval(timer); signal.removeEventListener("abort", abort); };
      const check = () => {
        try { const stream = this.get(ref); if (stream.status.lastSeq > afterSeq || stream.status.phase !== "open") { cleanup(); resolve(); } }
        catch (error) { cleanup(); reject(error); }
      };
      const abort = () => { cleanup(); reject(signal.reason); };
      // Recovery/deletion detection also works for another writer instance; no Resource watch wakes Output.
      const timer = setInterval(check, 1000);
      unsubscribe = this.subscribe(ref, check);
      signal.addEventListener("abort", abort, { once: true });
      check();
    });
  }
  subscribe(ref: StreamRef, listener: () => void): () => void {
    this.get(ref);
    let listeners = this.listeners.get(ref.uid);
    if (!listeners) this.listeners.set(ref.uid, listeners = new Set());
    listeners.add(listener);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(ref.uid); };
  }
}
