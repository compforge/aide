import type { PullRequestDiscoveryQuery } from "./protocol.ts";

/** @spec Discovery is author-scoped and paged; a capped or incomplete search must not advance a Source watermark. */
export function discoveryPage(query: PullRequestDiscoveryQuery): number {
  if (!/^[a-zA-Z0-9_.-]+$/.test(query.author)) throw new Error("Forge discovery requires a platform username");
  if (query.state !== "open" && query.state !== "all") throw new Error("Invalid Forge discovery state");
  const end = Date.parse(query.updatedBefore), start = query.updatedAfter ? Date.parse(query.updatedAfter) : undefined;
  if (!Number.isFinite(end) || (start !== undefined && (!Number.isFinite(start) || start > end))) throw new Error("Invalid Forge discovery time window");
  const page = Number(query.cursor ?? "1");
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("Invalid Forge discovery cursor");
  return page;
}
export function discoveryAuthor(value: unknown, field: "login" | "username", expected: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const username = (value as Record<string, unknown>)[field];
  return typeof username === "string" && username.toLowerCase() === expected.toLowerCase();
}
export function nextPage(headers: Headers, page: number, provider: "github" | "gitlab"): string | undefined {
  if (provider === "github") return headers.get("link")?.split(",").some(link => /;\s*rel="next"/.test(link)) ? String(page + 1) : undefined;
  const next = headers.get("x-next-page");
  if (!next) return undefined;
  if (!/^\d+$/.test(next) || Number(next) <= page) throw new Error("Forge discovery pagination did not advance");
  return next;
}
