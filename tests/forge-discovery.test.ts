import { expect, test } from "bun:test";
import { GitHubForgeConnector } from "../connectors/forge/github.ts";
import { GitLabForgeConnector } from "../connectors/forge/gitlab.ts";
import type { Fetch } from "../connectors/forge/http.ts";
const json = (data: unknown, headers: HeadersInit = {}) => new Response(JSON.stringify(data), { headers });
const before = "2026-10-26T00:00:00.000Z";

test("GitHub author discovery spans target repositories and refuses incomplete search coverage", async () => {
  let incomplete = false, total = 51;
  const urls: URL[] = [];
  const fetch: Fetch = async input => { urls.push(new URL(String(input))); return json({ incomplete_results: incomplete, total_count: total,
    items: [1, 2].map(n => ({ number: 7, user: { login: "me" }, pull_request: {}, repository_url: `https://api.github.com/repos/org/repo${n}` })) },
    { link: '<https://api.github.com/search/issues?page=2>; rel="next"' }); };
  const connector = new GitHubForgeConnector({ forge: "github.com", host: "github.com", provider: "github", token: "fixture" }, { fetch });
  const query = { author: "me", state: "all" as const, updatedAfter: "2026-10-25T00:00:00.000Z", updatedBefore: before };
  const page = await connector.discover(query);
  expect(page.items.map(i => i.path)).toEqual(["org/repo1", "org/repo2"]); expect(page.nextCursor).toBe("2");
  expect(urls[0]!.searchParams.get("q")).toBe(`is:pr author:me updated:${query.updatedAfter}..${before}`);
  await connector.discover({ ...query, state: "open", cursor: "2" }); expect(urls[1]!.searchParams.get("q")).toContain("is:open");
  incomplete = true; await expect(connector.discover(query)).rejects.toThrow("incomplete");
  incomplete = false; total = 1001; await expect(connector.discover(query)).rejects.toThrow("1000");
  const calls = urls.length; await expect(connector.discover({ ...query, author: "me repo:secret" })).rejects.toThrow("username"); expect(urls.length).toBe(calls);
});

test("GitLab uses explicit author across projects, including merged MRs and nested target paths", async () => {
  const urls: URL[] = [];
  const fetch: Fetch = async input => { urls.push(new URL(String(input))); return json([
    { iid: 8, state: "merged", author: { username: "me" }, web_url: "https://gitlab.test/team/sub/repo/-/merge_requests/8" },
    { iid: 8, state: "opened", author: { username: "me" }, web_url: "https://gitlab.test/another/repo/-/merge_requests/8" },
  ], { "x-next-page": "2" }); };
  const connector = new GitLabForgeConnector({ forge: "work", host: "gitlab.test", provider: "gitlab", token: "fixture" }, { fetch });
  const page = await connector.discover({ author: "me", state: "all", updatedBefore: before });
  expect(urls[0]!.pathname).toBe("/api/v4/merge_requests"); expect(urls[0]!.searchParams.get("scope")).toBe("all");
  expect(urls[0]!.searchParams.get("author_username")).toBe("me"); expect(urls[0]!.searchParams.get("state")).toBe("all");
  expect(page).toEqual({ items: [{ forge: "work", path: "team/sub/repo", number: 8 }, { forge: "work", path: "another/repo", number: 8 }], nextCursor: "2" });
});

test("GitHub and GitLab retain the head/base and terminal facts required by a Source", async () => {
  const github = new GitHubForgeConnector({ forge: "github.com", host: "github.com", provider: "github", token: "fixture" }, { fetch: async input => {
    if (String(input).endsWith("/graphql")) return json({ errors: [{ message: "unavailable" }] });
    return json({ number: 1, title: "PR", html_url: "https://github.com/org/repo/pull/1", state: "closed", merged_at: before, updated_at: before,
      head: { sha: "head" }, base: { sha: "base" } });
  } });
  const gitlab = new GitLabForgeConnector({ forge: "work", host: "gitlab.test", provider: "gitlab", token: "fixture" }, { fetch: async input => {
    if (String(input).includes("discussions")) return json([]);
    return json({ iid: 1, title: "MR", web_url: "https://gitlab.test/org/repo/-/merge_requests/1", state: "merged", merged_at: before, updated_at: before,
      sha: "head", diff_refs: { base_sha: "base" } });
  } });
  for (const connector of [github, gitlab]) expect(await connector.get({ forge: connector.forge, path: "org/repo", number: 1 })).toMatchObject({
    lifecycle: "merged", headSha: "head", baseSha: "base", updatedAt: before, mergedAt: before,
  });
});
