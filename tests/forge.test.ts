import {
  describe,
  expect,
  test,
} from "bun:test";

import { Connectors } from "../connectors/index.ts";
import { createConnectorClient, dispatchConnector } from "../src/connector-client.ts";
import { chiefTools } from "../agents/chief/chief-tools.ts";
import { createForgeConnectors, loadForgeConfigs } from "../connectors/forge/config.ts";

describe("Forge config", () => {
  test("separates Forge identity from endpoint host and uses devloop token precedence", () => {
    const config = {
      forges: {
        "github.com": {
          token: "configured-github",
          uids: ["octocat", "42"],
        },
        "code.example.com": {
          type: "gitlab",
          api_host: "gitlab-api.example.com",
          token: "configured-gitlab",
          uids: ["42", "owner"],
        },
      },
    };

    expect(loadForgeConfigs(config, {
      GITHUB_TOKEN: "environment-github",
      GITLAB_TOKEN: "environment-gitlab",
    })).toEqual([
      {
        forge: "github.com",
        provider: "github",
        host: "github.com",
        uids: ["octocat", "42"],
        token: "environment-github",
      },
      {
        forge: "code.example.com",
        provider: "gitlab",
        host: "gitlab-api.example.com",
        uids: ["42", "owner"],
        token: "environment-gitlab",
      },
    ]);
  });

  test("creates only authenticated Forge connectors", () => {
    const config = {
      forges: {
        "github.com": { type: "github" },
        "gitlab.example.com": {
          type: "gitlab",
          token: "configured",
        },
      },
    };

    expect(createForgeConnectors(config, { environment: {} }).map(
      (connector) => [connector.forge, connector.provider],
    )).toEqual([["gitlab.example.com", "gitlab"]]);
  });
});


for (const provider of ["github", "gitlab"] as const) test(`${provider} repocli reads cross Aide's JSON Connector boundary`, async () => {
  const calls: URL[] = [];
  const host = new Connectors([], createForgeConnectors({ forges: { work: { type: provider, api_host: `${provider}.example.com`, token: "fixture" } } }, {
    environment: {}, fetch: async (input, init) => {
      const url = new URL(String(input)); calls.push(url);
      expect(new Headers(init?.headers).get(provider === "github" ? "authorization" : "private-token")).toContain("fixture");
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
    },
  }));
  const client = createConnectorClient(async <T>(request: Parameters<typeof dispatchConnector>[1]): Promise<T> => {
    const value = await dispatchConnector(host, JSON.parse(JSON.stringify(request)));
    // In-process callers must be able to persist the same data that Runner receives.
    expect(structuredClone(value)).toEqual(JSON.parse(JSON.stringify(value)));
    return JSON.parse(JSON.stringify(value));
  });
  const reference = { repository: { forge: { name: "work" }, path: "org/repo" }, number: 7 };
  const page = await client.forges.discover("work", { author: "me", state: "all", updatedBefore: "2026-10-26T00:00:00Z" });
  expect(page.items).toEqual([reference]);
  expect(await client.forges.list("work", "org/repo", { state: "merged", limit: 5 })).toEqual([reference]);
  const observed = await client.forges.get(page.items[0]!);
  expect(observed).toMatchObject({ ...reference, state: "merged", headSha: "head", baseSha: "base", sourceBranch: "feature", targetBranch: "main" });
  expect("id" in observed).toBe(false); expect("id" in observed.repository).toBe(false);
  expect(observed.sourceRepository).toEqual({ forge: { name: "work" }, path: provider === "github" ? "contributor/repo" : "org/repo" });
  if (provider === "github") { expect(observed.reviewThreads).toBe("unknown"); expect(observed.reviewError).toContain("403"); }
  expect(await client.forges.comments(reference)).toEqual([]);
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
