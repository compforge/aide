import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { parsePersonalConfig } from "../plugins/personal/config.ts";
import { Aide } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { emptyConnectors } from "../src/connector-client.ts";
import { loadMeegoRequirementConfigs } from "../connectors/requirements/meego.ts";
import { fakeOptions } from "./fake-harness.ts";

const agent = { async execute(): Promise<never> { throw new Error("Unexpected work"); } };

test("Personal sources use one strict namespace, explicit scopes and no Lark kinds", () => {
  assert.deepEqual(parsePersonalConfig(), { sources: { requirements: [], forges: [] } });
  const policy = parsePersonalConfig({ sources: { lark: {}, environments: { targets: [] }, requirements: [] } });
  assert.equal(policy.sources.lark!.intervalMs, 60_000);
  assert.deepEqual(policy.sources.environments!.targets, []);
  for (const config of [
    { messages: {} }, { watches: [] }, { source: {} },
    { sources: null }, { sources: { lrak: {} } }, { sources: { lark: { kinds: [] } } },
    { sources: { environments: {} } },
    { sources: { environments: { targets: [{ environment: "dev", namespaces: [] }] } } },
    { sources: { requirements: [{ id: "mine", source: "work", userKeys: [] }] } },
  ]) assert.throws(() => parsePersonalConfig(config), /Invalid Personal config/);
  assert.throws(() => parsePersonalConfig({ sources: { lark: { intervalMs: "SECRET_SENTINEL" } } }),
    (error: unknown) => error instanceof Error && error.message.includes("sources.lark.intervalMs") && !error.message.includes("SECRET_SENTINEL"));
  assert.throws(() => loadMeegoRequirementConfigs({ requirements: {
    work: { provider: "meego", projectKey: "p", userKeys: ["me"] },
  } }), /Invalid Meego connector fields/);
});

test("Startup rejects Source references without matching Connectors before opening Sessions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-source-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configFile = join(root, "config.yaml");
  for (const sources of [
    { lark: {} },
    { forges: [{ id: "mine", forge: "missing", author: "me" }] },
    { environments: { targets: [{ environment: "missing", namespaces: ["app"] }] } },
    { requirements: [{ id: "mine", source: "missing", userKeys: ["me"] }] },
  ]) {
    writeFileSync(configFile, JSON.stringify({ plugins: { personal: { sources } } }));
    assert.throws(() => new Aide(root, { ...fakeOptions(agent, root), config: loadConfig(configFile) }, pino({ level: "silent" })),
      /connectors.lark|unknown connector/);
  }
});

test("Only configured sources poll; removing policies stops restored observers while Connector reads remain available", { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-source-lifecycle-"));
  const configFile = join(root, "config.yaml");
  const declarations = { environments: { dev: { kind: "kubernetes", kubeconfig: "unused" } },
    lark: { appId: "cli_app", userId: "ou_me", me: [{ appId: "cli_app", openId: "ou_me" }] },
    requirements: { work: { provider: "meego", projectKey: "p" } } };
  const person = { identities: [{ provider: "lark", scope: "cli_app", id: "ou_me" }] };
  const sources = { environments: { targets: [{ environment: "dev", namespaces: ["app"] }] }, lark: {},
    requirements: [{ id: "mine", source: "work", userKeys: ["me"] }, { id: "team", source: "work", userKeys: ["team"] }] };
  const seen = { environments: 0, messageKinds: [] as string[], assignees: [] as string[][] };
  const connectors = { ...emptyConnectors,
    environments: { ...emptyConnectors.environments, async workloads(environment: string, namespace?: string) {
      seen.environments++;
      return { environment, namespace: namespace!, observedAt: new Date().toISOString(), workloads: [] };
    } },
    messages: { ...emptyConnectors.messages,
      async identity() { return { accountId: "cli_app", userId: "ou_me" }; },
      async search(query: { chatType?: string }) {
        seen.messageKinds.push(query.chatType!);
        return { messages: [], hasMore: false, observedThrough: new Date().toISOString() };
      },
    },
    requirements: { ...emptyConnectors.requirements, async identity() { return { provider: "meego", scope: "fixture/p" }; }, async list(_source: string, query?: { assigneeUserKeys?: readonly string[] }) {
      seen.assignees.push([...query?.assigneeUserKeys ?? []]); return { items: [] };
    } },
  };
  const logs: Record<string, unknown>[] = [];
  const log = pino({}, { write(line) { logs.push(JSON.parse(line)); } });
  const create = () => new Aide(root, { ...fakeOptions(agent, root), connectors, config: loadConfig(configFile) }, log);
  writeFileSync(configFile, JSON.stringify({ connectors: declarations }));
  let aide = create();
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.start(); await aide.settled();
  assert.equal(aide.runtime.plugins.listInstances().length, 1);
  assert.equal(seen.environments, 0);
  assert.equal(seen.messageKinds.length, 0);
  assert.equal(seen.assignees.length, 0);
  await aide.close();

  writeFileSync(configFile, JSON.stringify({ connectors: declarations, plugins: { personal: { sources } } }));
  aide = create(); await aide.start(); await aide.settled();
  assert.ok(seen.environments > 0);
  assert.deepEqual([...new Set(seen.messageKinds)].sort(), ["group", "p2p"]);
  assert.deepEqual([...new Set(seen.assignees.map((keys) => keys.join(",")))].sort(), ["me", "team"]);
  const summary = logs.findLast((line) => line.msg === "Personal observation sources configured")!;
  assert.deepEqual(summary.lark, { intervalMs: 60_000, scenarios: ["direct", "mention", "sent"] });
  assert.doesNotMatch(JSON.stringify(summary), /ou_me|cli_app|userKeys/);
  const counts = structuredClone(seen);
  await aide.close();

  writeFileSync(configFile, JSON.stringify({ connectors: declarations, plugins: { personal: { sources: {} } } }));
  aide = create(); await aide.start(); await aide.settled();
  assert.deepEqual(seen, counts, "Restoring Source Sessions must not reactivate removed policies");
  await connectors.environments.workloads("dev", "manual");
  await connectors.requirements.list("work");
  assert.equal(seen.environments, counts.environments + 1);
  assert.deepEqual(seen.assignees.at(-1), []);
});

test("Topic configuration budgets context and rejects obsolete batching controls", () => {
  for (const key of ["maxPending", "batchSize", "maxWaitSeconds"]) assert.throws(() => parsePersonalConfig({ topic: { [key]: 5 } }), /Invalid Personal config/);
  assert.equal(parsePersonalConfig({ topic: { contextChars: 4096, summaryChars: 1000 } }).topic!.contextChars, 4096);
});


test("Meego Me resolves canonical identity without equating profile or watched people with Me", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-meego-me-"));
  const configFile = join(root, "config.yaml");
  writeFileSync(configFile, JSON.stringify({ connectors: { requirements: { work: {
    provider: "meego", projectKey: "alias", profile: "robot", me: { userKey: "human" },
  } } } }));
  const connectors = { ...emptyConnectors, requirements: { ...emptyConnectors.requirements,
    async identity() { return { provider: "meego", scope: "https://meego.test/canonical" }; },
    async list() { return { items: [] }; },
  } };
  const aide = new Aide(root, { ...fakeOptions(agent, root), connectors, config: loadConfig(configFile) }, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.start();
  const me = await aide.persons.findIdentity({ provider: "meego", scope: "https://meego.test/canonical", id: "human" });
  assert.ok(me?.spec.identities.some((identity) => identity.provider === "meego" && identity.scope === "https://meego.test/canonical" && identity.id === "human"));
  assert.ok(!me?.spec.identities.some((identity) => identity.id === "robot"));
});
