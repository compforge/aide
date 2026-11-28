import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { chmodSync } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { UsageFilter } from "./usage.ts";

export const usageRoles = ["gate", "route", "chief", "weave", "task", "routine"] as const;
export type UsageRole = typeof usageRoles[number];
export interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface UsageCall {
  id: string; at: number; provider: string; model: string; tokens?: Tokens; origin?: string; auxiliary?: string;
}
interface UsageRow {
  id: string; session: string; role: UsageRole; at: number; provider: string; model: string;
  origin: string | null; auxiliary: string | null; input: number | null; output: number | null;
  cache_read: number | null; cache_write: number | null;
}
function reportedTokens(tokens?: Tokens) {
  if (!tokens) return;
  const values = [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite];
  if (values.every(n => Number.isSafeInteger(n) && n >= 0) && values.some(n => n > 0)) return tokens;
}
export function usageCall(row: UsageRow): UsageCall {
  return { id: row.id, at: row.at, provider: row.provider, model: row.model, origin: row.origin ?? undefined,
    auxiliary: row.auxiliary ?? undefined, tokens: row.input === null ? undefined :
      { input: row.input, output: row.output!, cacheRead: row.cache_read!, cacheWrite: row.cache_write! } };
}

/** @spec Native entry IDs identify completed model responses and auxiliary spend within each Pi Session.
 * @link docs/observation.md#agent-usage
 * @case tests/agent-usage.test.ts
 */
export class UsageStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=100;
      CREATE TABLE IF NOT EXISTS calls (
        session TEXT NOT NULL, id TEXT NOT NULL, role TEXT NOT NULL, at INTEGER NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, origin TEXT, auxiliary TEXT,
        input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
        PRIMARY KEY (session, id)
      );
      CREATE INDEX IF NOT EXISTS calls_at ON calls(at);
      CREATE INDEX IF NOT EXISTS calls_session_at ON calls(session, at DESC, id);
      CREATE TABLE IF NOT EXISTS routed_inputs (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS routed_inputs_at ON routed_inputs(at);
    `);
  }
  close() { this.db.close(); }

  record(scope: string, session: string, entry: SessionEntry, origin?: string) {
    const role = usageRoles.find(role => scope.startsWith(role + ":"));
    if (!role) return;
    const at = Date.parse(entry.timestamp);
    if (!Number.isFinite(at)) return;
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "assistant") {
        this.insert(session, role, { id: entry.id, at, provider: message.provider, model: message.responseModel ?? message.model,
          origin: role === "chief" ? origin ?? "unknown" : undefined, tokens: reportedTokens(message.usage) });
      } else if (role === "route" && message.role === "toolResult" && message.toolName === "route_input" && !message.isError) {
        const result = message.content.find(part => part.type === "text");
        if (!result) return;
        let receipt: { routed?: unknown } | undefined;
        try { receipt = JSON.parse(result.text); } catch { return; }
        if (typeof receipt?.routed === "string") this.db.prepare("INSERT OR IGNORE INTO routed_inputs VALUES (?, ?)").run(receipt.routed, at);
      }
    } else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
      const model = entry.type === "usage" ? { provider: entry.provider, model: entry.model } : { provider: "unknown", model: "unknown" };
      this.insert(session, role, { id: entry.id, at, ...model,
        origin: role === "chief" ? origin : undefined, auxiliary: entry.type === "usage" ? entry.kind : entry.type, tokens: reportedTokens(entry.usage) });
    }
  }

  private insert(session: string, role: UsageRole, call: UsageCall) {
    const { id, at, provider, model, origin, auxiliary, tokens } = call;
    this.db.prepare("INSERT OR IGNORE INTO calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(session, id, role, at, provider, model, origin ?? null, auxiliary ?? null,
        tokens?.input ?? null, tokens?.output ?? null, tokens?.cacheRead ?? null, tokens?.cacheWrite ?? null);
  }
  private filter(since: number, until: number, filter: UsageFilter, session?: string) {
    const where = ["at BETWEEN ? AND ?"], params: SQLInputValue[] = [since, until];
    for (const [field, value] of [["role", filter.role], ["provider", filter.provider], ["model", filter.model], ["session", session]]) {
      if (value) { where.push(field + " = ?"); params.push(value); }
    }
    return { sql: where.join(" AND "), params };
  }
  *calls(since: number, until: number, filter: UsageFilter) {
    const { sql, params } = this.filter(since, until, filter);
    yield* this.db.prepare("SELECT * FROM calls WHERE " + sql).iterate(...params) as Iterable<UsageRow>;
  }
  models(since: number, until: number) {
    return this.db.prepare("SELECT DISTINCT provider, model FROM calls WHERE at BETWEEN ? AND ? ORDER BY provider, model")
      .all(since, until) as unknown as { provider: string; model: string }[];
  }
  hasSession(role: UsageRole, id: string) {
    return !!this.db.prepare("SELECT 1 FROM calls WHERE session=? AND role=? LIMIT 1").get(id, role);
  }
  sessionPage(id: string, since: number, until: number, filter: UsageFilter & { role: UsageRole }, page: number) {
    if (!this.hasSession(filter.role, id)) return;
    const { sql, params } = this.filter(since, until, filter, id);
    const pageSize = 50;
    const total = Number(this.db.prepare("SELECT count(*) AS n FROM calls WHERE " + sql).get(...params)!.n);
    const rows = this.db.prepare("SELECT * FROM calls WHERE " + sql + " ORDER BY at DESC, id LIMIT ? OFFSET ?")
      .all(...params, pageSize, (page - 1) * pageSize) as unknown as UsageRow[];
    return { items: rows.map(usageCall), total, pageSize };
  }
  routedInputs(since: number, until: number) {
    return Number(this.db.prepare("SELECT count(*) AS n FROM routed_inputs WHERE at BETWEEN ? AND ?").get(since, until)!.n);
  }
}
