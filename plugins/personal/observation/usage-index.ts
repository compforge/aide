import { open, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { deliveredMessageId } from "../../../agents/pi/input.ts";

export const usageRoles = ["gate", "route", "chief", "weave", "task", "routine"] as const;
export type UsageRole = typeof usageRoles[number];
export const usageWeek = 7 * 86_400_000;
export interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface UsageCall {
  id: string; at: number; provider: string; model: string; tokens?: Tokens;
  origin?: string; deliveries?: string[]; auxiliary?: string;
}
function reportedTokens(u?: Tokens) {
  if (!u) return;
  const fields = [u.input, u.output, u.cacheRead, u.cacheWrite];
  if (fields.every(n => Number.isSafeInteger(n) && n >= 0) && fields.some(n => n > 0))
    return { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite };
}
interface IndexedSession {
  id: string; role: UsageRole; calls: Map<string, UsageCall>; routed: Map<string, number>;
}
interface Source { origin?: string; deliveries?: string[]; pending?: boolean }
class Cursor {
  offset = 0;
  size = 0;
  mtime = 0;
  sessionId?: string;
  session?: IndexedSession;
  // Native entries form a tree. A fork must inherit its parent's task, even during incremental reads.
  readonly sources = new Map<string, Source>();
  constructor(readonly ino: number) {}
  accept(row: SessionEntry | SessionHeader, cwd: string, roles: readonly UsageRole[], since: number) {
    if (row.type === "session") {
      if (typeof row.cwd === "string" && resolve(row.cwd) === cwd) this.sessionId = row.id;
      return;
    }
    if (!this.sessionId || !row.id) return;
    if (row.type === "custom" && row.customType === "aide.agent-scope") {
      const scope = (row.data as { scope?: string } | null)?.scope;
      const role = roles.find(r => typeof scope === "string" && scope.startsWith(r + ":"));
      if (role && !this.session) this.session = { role, id: this.sessionId, calls: new Map(), routed: new Map() };
    }
    const session = this.session;
    if (!session) return;
    let source = this.sources.get(row.parentId ?? "");
    if (row.type === "custom" && row.customType === "aide.usage-origin") {
      const origin = (row.data as Source | null)?.origin;
      source = typeof origin === "string" ? { origin } : undefined;
    }
    if (row.type === "message" && row.message.role === "user") {
      const marker = deliveredMessageId(row.message.content);
      source = { pending: true, deliveries: [...(source?.pending ? source.deliveries ?? [] : []), marker ?? ""] };
    }
    if (row.type === "message" && row.message.role === "assistant" && source?.pending)
      source = { deliveries: source.deliveries };
    if (session.role === "chief" && source) this.sources.set(row.id, source);
    const at = Date.parse(row.timestamp);
    if (!(at >= since)) return;
    if (row.type === "usage" || row.type === "compaction" || row.type === "branch_summary") {
      // Pi may aggregate multiple model calls into one summary record.
      session.calls.set(row.id, { id: row.id, at, auxiliary: row.type === "usage" ? row.kind : row.type,
        provider: row.type === "usage" ? row.provider : "unknown", model: row.type === "usage" ? row.model : "unknown",
        tokens: reportedTokens(row.usage) });
      return;
    }
    if (row.type !== "message") return;
    const msg = row.message;
    if (msg.role === "assistant") {
      session.calls.set(row.id, { id: row.id, at, provider: msg.provider, model: msg.responseModel ?? msg.model,
        origin: source?.origin, deliveries: source?.deliveries, tokens: reportedTokens(msg.usage) });
    }
    if (session.role === "route" && msg.role === "toolResult" && msg.toolName === "route_input" && !msg.isError) {
      if (!Array.isArray(msg.content)) return;
      const block = msg.content.find(part => part?.type === "text");
      if (!block) return;
      try {
        const receipt = JSON.parse(block.text);
        if (typeof receipt?.routed === "string") session.routed.set(receipt.routed, at);
      } catch { /* Older tool results without a structured routing receipt. */ }
    }
  }
}

/** @spec Index only complete native entries from the configured cwd and role directories.
 * @why Rebuilding from source keeps recovery and prompt bodies in Pi's native store.
 * @link docs/observation.md
 */
export class UsageIndex {
  private files = new Map<string, Cursor>();
  private scanning?: Promise<void>;
  private lastScan = 0;
  latest() {
    return this.scanning ?? (Date.now() - this.lastScan < 10_000 ? Promise.resolve() : this.refresh());
  }
  constructor(private cwd: string, private directories: Map<string, UsageRole[]>) {}
  refresh(now = Date.now()) {
    return this.scanning ??= this.scan(now - usageWeek).then(() => { this.lastScan = now; }).finally(() => { this.scanning = undefined; });
  }
  sessions(): IndexedSession[] {
    return [...this.files.values()].flatMap(file => file.session ? [file.session] : []);
  }
  private async scan(since: number) {
    const retained = new Set<string>();
    for (const [dir, roles] of this.directories) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const path = join(dir, entry.name);
        const info = await stat(path).catch(error => {
          if (error.code !== "ENOENT") throw error;
        });
        if (!info || info.mtimeMs < since) continue;
        retained.add(path);
        let cursor = this.files.get(path);
        if (cursor && cursor.ino === info.ino && cursor.size === info.size && cursor.mtime === info.mtimeMs) continue;
        const file = await open(path, "r").catch(error => {
          if (error.code !== "ENOENT") throw error;
        });
        if (!file) continue;
        try {
          const st = await file.stat();
          if (!cursor || cursor.ino !== st.ino || st.size < cursor.size || (st.size === cursor.size && st.mtimeMs !== cursor.mtime)) {
            cursor = new Cursor(st.ino);
            this.files.set(path, cursor);
          }
          if (cursor.offset < st.size) {
            let pending: Buffer = Buffer.alloc(0);
            for await (const chunk of file.createReadStream({ start: cursor.offset, end: st.size - 1, autoClose: false })) {
              const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk as Buffer;
              let pos = 0, end: number;
              while ((end = bytes.indexOf(10, pos)) !== -1) {
                let row;
                try { row = JSON.parse(bytes.toString("utf8", pos, end)); } catch { /* Skip malformed complete records. */ }
                if (row && typeof row === "object" && (row.type !== "message" || row.message?.role)) cursor.accept(row, this.cwd, roles, since);
                cursor.offset += end + 1 - pos;
                pos = end + 1;
              }
              pending = bytes.subarray(pos);
            }
          }
          cursor.size = st.size;
          cursor.mtime = st.mtimeMs;
          if (cursor.session) {
            for (const [id, call] of cursor.session.calls) if (call.at < since) cursor.session.calls.delete(id);
            for (const [id, at] of cursor.session.routed) if (at < since) cursor.session.routed.delete(id);
          }
        } finally { await file.close(); }
      }
    }
    for (const path of this.files.keys()) if (!retained.has(path)) this.files.delete(path);
  }
}
