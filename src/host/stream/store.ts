import { randomUUID } from "node:crypto";
import type { Stream, StreamRef, StreamDelta, StreamChunk, StreamSnapshot, ResourceOwnerReference } from "@compforge/aide-plugin";
import { STREAM_TYPE } from "@compforge/aide-plugin";
import { ResourceStorage } from "../resource/storage.ts";
import { PluginResourceStore } from "../plugin/resource/store.ts";
import { StreamDefinition } from "./definition.ts";

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
    this.storage.db.exec(`CREATE TABLE IF NOT EXISTS stream_chunks (
      uid TEXT NOT NULL REFERENCES resources(uid) ON DELETE CASCADE,
      seq INTEGER NOT NULL, kind TEXT NOT NULL, delta TEXT NOT NULL, PRIMARY KEY(uid,seq));`);
  }
  reference(name: string, uid = `stream:${randomUUID()}`): StreamRef { return { ...STREAM_TYPE, namespace: "v1", name, uid }; }
  create(ref: StreamRef, owner: ResourceOwnerReference): Stream {
    return this.storage.transaction(() => this.createOwned(ref, owner));
  }
  private createOwned(ref: StreamRef, owner: ResourceOwnerReference): Stream {
    const key = this.resources.key(ref, ref.name, ref.namespace);
    const current = this.storage.read(key);
    if (current) {
      const stream = this.get(ref);
      if (stream.metadata.owner?.uid !== owner.uid) throw new Error("Stream owner mismatch");
      return stream;
    }
    const parent = this.resources.get(owner, owner.name, owner.namespace);
    if (parent.metadata.uid !== owner.uid || parent.metadata.deletionTimestamp) throw new Error("Stream owner is unavailable");
    const stream: Stream = { ...STREAM_TYPE, metadata: { name: ref.name, namespace: owner.namespace, uid: ref.uid,
      owner, creationTimestamp: new Date().toISOString(), generation: 1, resourceVersion: "1" }, spec: {}, status: { phase: "open", lastSeq: 0 } };
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
  append(ref: StreamRef, chunks: readonly StreamDelta[]): void {
    if (!chunks.length) return;
    this.change(ref, stream => {
      const insert = this.storage.db.prepare("INSERT INTO stream_chunks VALUES (?,?,?,?)");
      let bytes = 0;
      for (const chunk of chunks) {
        if (!["think", "text"].includes(chunk.kind) || typeof chunk.delta !== "string") throw new Error("Invalid Stream delta");
        if (!chunk.delta) continue;
        insert.run(ref.uid, ++stream.status.lastSeq, chunk.kind, chunk.delta);
        bytes += Buffer.byteLength(chunk.delta);
      }
      this.storage.db.prepare("INSERT INTO resource_payload_sizes VALUES (?,?) ON CONFLICT(uid) DO UPDATE SET bytes=bytes+excluded.bytes").run(ref.uid, bytes);
      // ResourceStorage accounts attached content against the same per-resource, kind and Host quotas.
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
      this.storage.write(this.resources.key(ref, ref.name, ref.namespace), this.scope, { object: next, control: {} });
      this.storage.afterCommit(() => { for (const listener of this.listeners.get(ref.uid) ?? []) listener(); });
    });
  }
  read(ref: StreamRef, afterSeq = 0, limit = 256): StreamChunk[] {
    this.get(ref);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1024) throw new Error("Invalid Stream cursor or page size");
    return this.storage.db.prepare("SELECT seq,kind,delta FROM stream_chunks WHERE uid=? AND seq>? ORDER BY seq LIMIT ?").all(ref.uid, afterSeq, limit).map(row => ({ seq: Number(row.seq), kind: row.kind as StreamChunk["kind"], delta: String(row.delta) }));
  }
  snapshot(ref: StreamRef): StreamSnapshot {
    return this.storage.transaction(() => {
      const stream = this.get(ref);
      const rows = this.storage.db.prepare("SELECT kind,group_concat(delta,'') AS text FROM (SELECT kind,delta FROM stream_chunks WHERE uid=? ORDER BY seq) GROUP BY kind").all(ref.uid);
      return { ...stream.status, think: String(rows.find(r => r.kind === "think")?.text ?? ""), text: String(rows.find(r => r.kind === "text")?.text ?? "") };
    });
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
