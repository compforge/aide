import {
  describe,
  expect,
  test,
} from "bun:test";

import { createConnectors } from "./connector-fixture.ts";
import { createConnectorClient, dispatchConnector } from "../src/connector/client.ts";
import { chiefTools } from "../agents/chief/chief-tools.ts";
import { createForgeReader } from "@compforge/repocli";

for (const provider of ["github", "gitlab"] as const) test(`${provider} repocli reads cross Aide's JSON Connector boundary`, async () => {
  const calls: URL[] = [];
  const host = createConnectors([], [createForgeReader({forge:"work",provider:provider,host:`${provider}.example.com`,token:"fixture"}, {fetch: async (input, init) => {
      const url = new URL(String(input)); calls.push(url);
      expect(new Headers(init?.headers).get(provider === "github" ? "authorization" : "private-token")).toContain("fixture");
      if (url.pathname.endsWith("/user/repos") || url.pathname === "/api/v4/projects") {
        const second = url.searchParams.get("page") === "2";
        const rows = provider === "github" ? [{ full_name: second ? "org/second" : "org/first" }] : [{ path_with_namespace: second ? "org/second" : "org/first" }];
        const next = new URL(url); next.searchParams.set("page", "2");
        return Response.json(rows, { headers: second ? {} : provider === "github" ? { link: `<${next}>; rel="next"` } : { "x-next-page": "2" } });
      }
      if (url.pathname.endsWith("/graphql")) return new Response("Review unavailable", { status: 403 });
      const github = { number: 7, title: "Shared facts", html_url: "https://github.example.com/org/repo/pull/7", state: "closed", merged: true,
        head: { sha: "head", ref: "feature", repo: { full_name: "contributor/repo" } }, base: { sha: "base", ref: "main" } };
      const gitlab = { iid: 7, title: "Shared facts", web_url: "https://gitlab.example.com/org/repo/-/merge_requests/7", state: "merged",
        sha: "head", diff_refs: { base_sha: "base" }, source_branch: "feature", target_branch: "main", source_project_id: 42, target_project_id: 42, author: { username: "me" } };
      if (url.pathname.endsWith("/search/issues")) return Response.json({ total_count: 1, incomplete_results: false,
        items: [{ number: 7, user: { login: "me" }, pull_request: {}, repository_url: "https://github.example.com/api/v3/repos/org/repo" }] });
      if (url.pathname === "/api/v4/merge_requests") return Response.json([gitlab]);
      if (url.pathname.endsWith("/discussions") || url.pathname.endsWith("/comments")) return Response.json([]);
      if (url.pathname.endsWith("/pulls")) return Response.json([{ ...github, merged_at: "2026-10-26T00:00:00Z" }]);
      if (url.pathname.endsWith("/merge_requests")) return Response.json([gitlab]);
      return Response.json(provider === "github" ? github : gitlab);
    }})]);
  const client = createConnectorClient(async <T>(request: Parameters<typeof dispatchConnector>[1]): Promise<T> => {
    const value = await dispatchConnector(host, JSON.parse(JSON.stringify(request)));
    // In-process callers must be able to persist the same data that Runner receives.
    expect(structuredClone(value)).toEqual(JSON.parse(JSON.stringify(value)));
    return JSON.parse(JSON.stringify(value));
  });
  const first = await client.forges.listRepositories("work", { pageSize: 5 });
  expect(first.items).toEqual([{ forge: { name: "work" }, path: "org/first" }]);
  expect(first.nextCursor).toBeString();
  const second = await client.forges.listRepositories("work", { pageSize: 5, cursor: first.nextCursor });
  expect(second.items).toEqual([{ forge: { name: "work" }, path: "org/second" }]);
  expect(second.nextCursor).toBeUndefined();
  const reference = { repository: { forge: { name: "work" }, path: "org/repo" }, number: 7 };
  const page = await client.forges.scanPullRequests("work", { scope: { kind: "account", author: "me" } });
  expect(page.items).toHaveLength(1); expect(page.items[0]).toMatchObject(reference);
  expect(typeof page.cursor).toBe("string");
  expect((await client.forges.listPullRequests("work", { scope: {kind: "repository", repository: reference.repository}, state: "merged", pageSize: 5 })).items).toEqual([reference]);
  const observed = await client.forges.getPullRequest(page.items[0]!);
  expect(observed).toMatchObject({ ...reference, state: "merged", headSha: "head", baseSha: "base", sourceBranch: "feature", targetBranch: "main" });
  expect("id" in observed).toBe(false); expect("id" in observed.repository).toBe(false);
  expect(observed.sourceRepository).toEqual({ forge: { name: "work" }, path: provider === "github" ? "contributor/repo" : "org/repo" });
  expect(calls.some(url => url.pathname.endsWith("/graphql") || url.pathname.endsWith("/discussions"))).toBe(false);
  if (provider === "github") await expect(client.forges.getPullRequestReview(reference)).rejects.toThrow("403");
  else expect((await client.forges.getPullRequestReview(reference)).reviewThreadState).toBe("none");
  expect(await client.forges.listPullRequestComments(reference)).toEqual([]);
  // Chief keeps compact tool arguments while the Connector uses the shared reference shape.
  for (const name of ["read_pull_request", "read_pull_request_comments"]) {
    const tool = chiefTools(client).find(tool => tool.name === name)!;
    const result = await tool.execute("call", { forge: "work", path: "org/repo", number: 7 }, undefined, undefined, {} as never);
    const content = result.content[0];
    expect(content?.type).toBe("text");
    if (content?.type !== "text") throw new Error("Missing tool result");
    const value = JSON.parse(content.text);
    if (name === "read_pull_request") expect(value).toMatchObject({ ...reference, state: "merged" });
    else expect(value).toEqual([]);
  }
  expect(calls.length).toBeGreaterThan(4);
});

test("repository rate-limit hints survive the JSON Connector boundary", async () => {
  const host = createConnectors([], [createForgeReader({forge:"work",provider:"gitlab",host:"work",token:"fixture"}, {fetch: async () => new Response("limited", { status: 429, headers: { "retry-after": "120" } })})]);
  const client = createConnectorClient(async <T>(request: Parameters<typeof dispatchConnector>[1]): Promise<T> =>
    JSON.parse(JSON.stringify(await dispatchConnector(host, JSON.parse(JSON.stringify(request))))));
  const page = await client.forges.listRepositories("work");
  expect(page.items).toEqual([]);
  expect(page.issues?.[0]).toMatchObject({ stage: "list", kind: "rate_limit", retryAfterMs: 120_000 });
});

test("Forge Me metadata is explicit, scoped and independent of credentials", async () => {
  const { Connectors } = await import("../connectors/index.ts");
  const connectors = await Connectors.load({ work: { kind: "forge", version: "v1", enabled: true,
    config: { provider: "github", host: "github.example", forge: "work-forge", tokenEnv: "BOT_TOKEN", me: { username: "human" } } } },
    { environment: { BOT_TOKEN: "private-execution-token" } });
  try {
    const [entry] = await connectors.list("forge");
    expect(entry!.metadata).toEqual({ forge: "work-forge", provider: "github", me: { username: "human" } });
    expect(JSON.stringify(entry)).not.toContain("private-execution-token");
  } finally { await connectors.close(); }
  await expect(Connectors.load({ work: { kind: "forge", version: "v1", enabled: true,
    config: { provider: "github", host: "github.example", me: { username: " " } } } })).rejects.toThrow();
});
