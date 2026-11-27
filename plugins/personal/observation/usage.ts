import { usageRoles, usageCall, type UsageStore, type Tokens, type UsageRole, type UsageCall } from "./usage-store.ts";

export interface UsageFilter { window: "24h" | "7d"; role?: UsageRole; provider?: string; model?: string }

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
const windowStart = (now: number, filter: UsageFilter) => now - (filter.window === "7d" ? 7 : 1) * 86_400_000;

export function sessionCalls(store: UsageStore, id: string, filter: UsageFilter & { role: UsageRole }, page: number, now = Date.now()) {
  return store.sessionPage(id, windowStart(now, filter), now, filter, page);
}
export function usageReport(store: UsageStore, filter: UsageFilter, now = Date.now()) {
  const since = windowStart(now, filter);
  const roles = new Map(usageRoles.map(role => [role, new Group()]));
  const byOrigin = new Map<string, Group>();
  const byModel = new Map<string, Group>();
  const bySession = new Map<string, Group>();
  const minuteTotals = new Map<number, number>();
  const identities = new Map<string, UsageRole>();
  for (const row of store.calls(since, now, filter)) {
    const call = usageCall(row);
    if (call.tokens) {
      const minute = Math.floor(call.at / 60_000) * 60_000;
      const { input, output, cacheRead, cacheWrite } = call.tokens;
      minuteTotals.set(minute, (minuteTotals.get(minute) ?? 0) + input + output + cacheRead + cacheWrite);
    }
    roles.get(row.role)!.add(row.session, call);
    group(byModel, JSON.stringify([call.provider, call.model])).add(row.session, call);
    group(bySession, row.session).add(row.session, call);
    identities.set(row.session, row.role);
    if (row.role === "chief") group(byOrigin, call.origin ?? "unknown").add(row.session, call);
  }
  const models = [...byModel].map(([key,g]) => {
    const [provider, model] = JSON.parse(key) as [string, string];
    return { provider, model, ...g.result() };
  });
  const modelOptions = filter.role || filter.provider || filter.model
    ? store.models(since, now)
    : models.map(({ provider, model }) => ({ provider, model }));
  const route = roles.get("route")!.result();
  // Successful receipts belong to Inputs; a routed Input can span several models.
  const includeRoute = !filter.role || filter.role === "route";
  const routeInputs = includeRoute && !filter.model && !filter.provider ? store.routedInputs(since, now) : null;
  return { since, until: now, minutes: [...minuteTotals].sort(([a], [b]) => a - b).map(([at, tokens]) => ({ at, tokens })), routeInputs, tokensPerRouteInput: routeInputs && (route.covered || route.auxiliaryTokens) ? route.total / routeInputs : null,
    roles: [...roles].map(([role,g]) => ({ role, ...g.result() })),
    origins: [...byOrigin].map(([origin,g]) => ({ origin, ...g.result() })),
    models, modelOptions,
    sessions: [...bySession].map(([id,g]) => ({ id, role: identities.get(id)!, ...g.result() })).sort((a,b) => b.total-a.total).slice(0,20) };
}
export type UsageReport = ReturnType<typeof usageReport>;
