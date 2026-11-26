import { usageRoles, type UsageIndex, type Tokens, type UsageRole, type UsageCall } from "./usage-index.ts";
import { BUSINESS_INPUT_ORIGINS, INPUT_ORIGINS } from "../input/model.ts";
import type { TopicStore } from "../topic/store.ts";
import { BATCH_TYPE, type BatchSpec, type BatchStatus } from "../batch/model.ts";
import type { InputStatus } from "../input/model.ts";

export interface UsageFilter { window: "24h" | "7d"; role?: UsageRole; provider?: string; model?: string }
const business = new Set<string>(BUSINESS_INPUT_ORIGINS);
const origins = new Set<string>(INPUT_ORIGINS);
export function usageOrigin(origin: string) {
  if (business.has(origin)) return "business";
  return origins.has(origin) || origin === "mixed" || origin === "business" ? origin : "unknown";
}

/**
 * @spec Historical attribution matches the exact native Session and admission marker.
 * @why Build one request-local lookup on demand so old Sessions cannot trigger thousands of resource queries.
 * @link docs/observation.md#agent-usage
 */
export function receiptOriginLookup(topics: Pick<TopicStore, "inputStore" | "resources">): OriginLookup {
  let index: Map<string, string> | undefined;
  const key = (session: string, marker: string) => JSON.stringify([session, marker]);
  return (session, marker) => {
    if (!index) {
      const origins = new Map<string, string>();
      const collect = (receipt: InputStatus["assess"], origin: string) => {
        if (!receipt?.executionId || !receipt.agent?.sessionId) return;
        const id = key(receipt.agent.sessionId, receipt.deliveryId ?? receipt.executionId);
        const previous = origins.get(id);
        origins.set(id, previous && previous !== origin ? "mixed" : origin);
      };
      for (const input of topics.inputStore.list()) {
        if (!input.status.batchId && !input.metadata.deletionTimestamp)
          collect(input.status.assess, usageOrigin(input.spec.origin));
      }
      // Batch admission accepts only compatible business Inputs.
      for (const batch of topics.resources.list<BatchSpec, BatchStatus>(BATCH_TYPE))
        collect(batch.status.assess, "business");
      index = origins;
    }
    return index.get(key(session, marker)) ?? "unknown";
  };
}

class Group {
  calls = 0;
  auxiliaryRecords = 0;
  auxiliaryTokens = 0;
  sizes: number[] = [];
  sessions = new Set<string>();
  totals: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  add(id: string, call: UsageCall) {
    if (call.auxiliary) this.auxiliaryRecords++;
    else this.calls++;
    this.sessions.add(id);
    const u = call.tokens;
    if (!u) return;
    for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) this.totals[field] += u[field];
    if (call.auxiliary) this.auxiliaryTokens += u.input + u.cacheRead + u.cacheWrite + u.output;
    else this.sizes.push(u.input + u.cacheRead + u.cacheWrite);
  }
  result() {
    this.sizes.sort((a,b) => a-b);
    const quantile = (p: number) => this.sizes[Math.ceil(p * this.sizes.length) - 1] ?? null;
    return { calls: this.calls, auxiliaryRecords: this.auxiliaryRecords, auxiliaryTokens: this.auxiliaryTokens, sessions: this.sessions.size, covered: this.sizes.length, ...this.totals,
      median: quantile(0.5), p95: quantile(0.95), total: Object.values(this.totals).reduce((a,b) => a+b, 0) };
  }
}
function group(map: Map<string,Group>, key: string) {
  let value = map.get(key);
  if (!value) { value = new Group(); map.set(key, value); }
  return value;
}
type OriginLookup = (session: string, marker: string) => string;
function originResolver(lookup: OriginLookup) {
  const cache = new Map<string,string>();
  return (id: string, call: UsageCall) => {
    if (call.origin || !call.deliveries?.length) return usageOrigin(call.origin ?? "unknown");
    const values = new Set(call.deliveries.map(marker => {
      if (!marker) return "unknown";
      const key = JSON.stringify([id,marker]);
      const origin = cache.get(key) ?? lookup(id,marker);
      cache.set(key,origin);
      return origin;
    }));
    if (values.has("unknown")) return "unknown";
    return values.size === 1 ? [...values][0]! : "mixed";
  };
}
function matches(call: UsageCall, since: number, now: number, filter: UsageFilter) {
  return call.at >= since && call.at <= now && (!filter.model || filter.model === call.model)
    && (!filter.provider || filter.provider === call.provider);
}
const windowStart = (now: number, filter: UsageFilter) => now - (filter.window === "7d" ? 7 : 1) * 86_400_000;

export function sessionCalls(index: UsageIndex, id: string, filter: UsageFilter, lookup: OriginLookup, page: number, now = Date.now()) {
  const since = windowStart(now, filter), origin = originResolver(lookup);
  const calls = new Map<string,UsageCall>();
  const sessions = index.sessions().filter(s => s.role === filter.role && s.id === id);
  if (!sessions.length) return;
  for (const session of sessions) for (const call of session.calls.values()) {
    if (matches(call,since,now,filter)) calls.set(call.id,call);
  }
  const pageSize = 50, offset = (page - 1) * pageSize;
  const items = [...calls.values()].sort((a,b) => b.at-a.at || a.id.localeCompare(b.id)).slice(offset,offset+pageSize)
    .map(({ deliveries, ...call }) => ({ ...call, origin: filter.role === "chief" ? origin(id,{ ...call, deliveries }) : undefined }));
  return { items, total: calls.size, pageSize };
}
export function usageReport(index: UsageIndex, filter: UsageFilter, lookup: OriginLookup, now = Date.now()) {
  const since = windowStart(now, filter);
  const roles = new Map(usageRoles.map(role => [role, new Group()]));
  const byOrigin = new Map<string,Group>(), byModel = new Map<string,Group>(), bySession = new Map<string,Group>();
  const seen = new Set<string>(), routed = new Set<string>(), origin = originResolver(lookup);
  const identities = new Map<string,UsageRole>();
  for (const session of index.sessions()) {
    if (filter.role && filter.role !== session.role) continue;
    identities.set(session.id, session.role);
    for (const [id, at] of session.routed) if (at >= since && at <= now) routed.add(id);
    for (const call of session.calls.values()) {
      if (!matches(call,since,now,filter)) continue;
      const key = JSON.stringify([session.id, call.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      roles.get(session.role)!.add(session.id, call);
      group(byModel, JSON.stringify([call.provider,call.model])).add(session.id, call);
      group(bySession, session.id).add(session.id, call);
      if (session.role === "chief") {
        group(byOrigin, origin(session.id,call)).add(session.id,call);
      }
    }
  }
  const route = roles.get("route")!.result();
  // Successful receipts belong to Inputs; a routed Input can span several models.
  const routeInputs = filter.model || filter.provider ? null : routed.size;
  return { since, until: now, routeInputs, tokensPerRouteInput: routeInputs && (route.covered || route.auxiliaryTokens) ? route.total / routeInputs : null,
    roles: [...roles].map(([role,g]) => ({ role, ...g.result() })),
    origins: [...byOrigin].map(([origin,g]) => ({ origin, ...g.result() })),
    models: [...byModel].map(([key,g]) => { const [provider,model] = JSON.parse(key) as [string,string]; return { provider,model,...g.result() }; }),
    sessions: [...bySession].map(([id,g]) => ({ id, role: identities.get(id)!, ...g.result() })).sort((a,b) => b.total-a.total).slice(0,20) };
}
export type UsageReport = ReturnType<typeof usageReport>;
