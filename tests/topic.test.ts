import { fixtureIncoming } from "./address-fixture.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { assessAll } from "./input-state-fixture.ts";
import { admit } from "./input-state-fixture.ts";
import { loadConfig } from "../src/config.ts";
import { emptyConnectors } from "../src/connector-client.ts";
import { SOURCE_TYPE } from "../plugins/personal/source/requirement/observe.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import pino from "pino";
import { TopicStore, seedInput } from "./topic-fixture.ts";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";

async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await Bun.sleep(10); }
  assert.fail("Timed out waiting for topic");
}

test("Independent Input facts and Personal consumption survive reopening with version guards", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aide-topic-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new TopicStore({ dir });
  const first = await seedInput(store, "m1", { topicId: "group-a", origin: "channel", originId: "web", text: "one-body-only" });
  assert.equal(store.inputStore.submit("personal", "m1", first.spec).metadata.uid, first.metadata.uid);
  await seedInput(store, "s1", { topicId: "watch-a", origin: "source", originId: "personal.environments", text: "requirement changed", observation: { id: "req-1" } });
  assert.deepEqual(store.get("watch-a")!.outputs, []);
  assert.equal(store.inputStore.list().length, 2);
  const c = store.resource("group-a")!;
  const client = createResourceClient(store.resources);
  await client.patchStatus(c, { execution: { id: "exec", startedAt: new Date().toISOString() } });
  await assert.rejects(client.patchStatus(c, { summary: "stale" }), /version conflict/);
  assert.equal(store.input("m1")!.metadata.resourceVersion, store.inputStore.get("m1")!.metadata.resourceVersion);
  await admit(client, "m1", c.metadata.uid, "exec");
  await assessAll(client, c, "exec", { inputIds: ["m1"], summary: "answer" });
  await assert.rejects(assessAll(client, c, "wrong", { inputIds: ["m1"], summary: "answer" }), /no longer active/);
  const reopened = new TopicStore({ dir });
  assert.equal(reopened.input("m1")!.consumption.phase, "done");
  assert.deepEqual(reopened.get("group-a")!.pendingInputIds, []);

});

test("Chief serializes inputs within a topic while another topic can proceed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-topic-queue-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: Array<{ topicId: string; text: string; prompt: string }> = [];
  const aide = new Aide(root, fakeOptions({ async chief(prompt) {
    const spec = JSON.parse(prompt.split("Activation: ")[1]!.split("\n")[0]!);
    spec.text = spec.inputs[0].description.split("\n\nText:\n")[1];
    calls.push({ ...spec, prompt });
    if (spec.text === "a-first") await gate;
    return `answer:${spec.text}`;
  }, async execute() { throw new Error("Unexpected work"); } }, root), pino({ level: "silent" }));
  t.after(async () => { release(); await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.receive(fixtureIncoming({ channelId: "lark", id: "1",  topicId: "lark:bot:group-a", text: "a-first" }));
  await until(() => calls.length === 1);
  await aide.receive(fixtureIncoming({ channelId: "lark", id: "2",  topicId: "lark:bot:group-a", text: "a-second" }));
  await aide.receive(fixtureIncoming({ channelId: "lark", id: "1",  topicId: "lark:bot:group-b", text: "b-first" }));
  await until(() => calls.some((call) => call.text === "b-first"));
  assert.ok(!calls.some((call) => call.text === "a-second"));
  assert.doesNotMatch(calls.find((call) => call.text === "b-first")!.prompt, /a-first|a-second/);
  release(); await aide.settled();
  assert.deepEqual(calls.filter((call) => call.topicId.endsWith("group-a")).map((call) => call.text), ["a-first", "a-second"]);
  assert.equal(aide.topicIds().length, 2);
  assert.throws(() => aide.personal.store.resources.list({ apiVersion: "aide.dev/v1alpha1", kind: "ChiefInput" }), /Unknown resource definition/);
  assert.equal(aide.personal.store.resources.list({ apiVersion: "aide.dev/v1alpha1", kind: "Topic" }).length, 2);
});

test("Startup resumes queued inputs but fails interrupted input without replaying its actions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-topic-restart-"));
  const calls: string[] = [];
  const options = fakeOptions({ async chief(prompt) { calls.push(prompt); return "finished"; }, async execute() { throw new Error("Unexpected work"); } }, root);
  let aide = new Aide(root, options, pino({ level: "silent" }));
  const active = await seedInput(aide.personal.topics, "active", { topicId: "a", text: "do-not-replay", origin: "channel", originId: "web" });
  const interrupted = aide.personal.topics.resource("a")!;
  const client = aide.personal.plugins.resourceClient("personal");
  await client.patchStatus(interrupted, { execution: { id: "interrupted", startedAt: new Date().toISOString() } });
  await admit(client, active.metadata.name, interrupted.metadata.uid, "interrupted");
  await seedInput(aide.personal.topics, "queued", { topicId: "b", text: "process-after-restart", origin: "channel", originId: "web" });
  await aide.close();
  aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.start(); await aide.settled();
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /process-after-restart/);
  assert.doesNotMatch(calls[0]!, /do-not-replay/);
  assert.equal(aide.personal.topics.input("active")!.consumption.phase, "failed");
  const notices = aide.outputs().filter((m) => m.topicId === "a");
  assert.equal(notices.length, 0);
  await aide.personal.recoverInterrupted();
  assert.deepEqual(aide.outputs().filter((m) => m.topicId === "a"), notices);
  assert.equal(aide.personal.topics.input("queued")!.consumption.phase, "done");
});

test("Source watches restore once globally, independently of Channel topics", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-source-routing-"));
  const path = join(root, "config.yaml");
  writeFileSync(path, JSON.stringify({ connectors: {work: {kind:"requirement",version:"v1",config:{ provider: "meego", projectKey: "p" }}},
    plugins: { personal: { sources: { requirements: [
      { id: "one", source: "work", userKeys: ["me"], topicKey: "source:one" },
      { id: "two", source: "work", userKeys: ["me"], topicKey: "source:two" },
    ] } } } }));
  let polls = 0;
  const options = { ...fakeOptions({ execute: async () => { throw new Error("Unexpected execution"); } }, root), config: loadConfig(path),
    connectors: { ...emptyConnectors, requirements: { ...emptyConnectors.requirements, identity: async () => ({ provider: "meego", scope: "fixture/p" }), list: async () => { polls++; return { items: [] }; } } } };
  let aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.start(); await aide.settled();
  assert.ok(polls >= 2);
  const initialPolls = polls;
  await aide.receive(fixtureIncoming({ channelId: "web",  topicId: "web-conv", id: "hello", text: "hello" })); await aide.settled();
  assert.equal(polls, initialPolls);
  assert.equal(aide.personal.store.resources.list(SOURCE_TYPE).length, 2);
  for (const id of ["source:one", "source:two"]) assert.equal(aide.personal.store.resources.list(SOURCE_TYPE).length, 2);
  assert.equal(aide.topics.get("source:one"), undefined, "A Source with no Input must not create an empty topic");
  assert.ok(aide.topics.get("web-conv"));
  const sourceIds = ["source:one", "source:two"].map((id) => aide.personal.store.resources.list(SOURCE_TYPE)[0]!.metadata.uid);
  await aide.close();
  aide = new Aide(root, options, pino({ level: "silent" }));
  await aide.start(); await aide.settled();
  assert.equal(aide.runtime.plugins.listInstances().length, 1);
  assert.deepEqual(["source:one", "source:two"].map((id) => aide.personal.store.resources.list(SOURCE_TYPE)[0]!.metadata.uid), sourceIds);
  assert.equal(aide.personal.store.resources.list(SOURCE_TYPE).length, 2);
  assert.equal(aide.topics.get("source:one"), undefined);
});


test("Topic names come from the first attached Input and survive restart for Channel and Source topics", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-topic-name-"));
  const options = fakeOptions({ chief: async () => "收到",
    execute: async () => { throw new Error("No Work expected"); } }, root);
  let aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const topicId = "lark:app:group";
  await aide.receive(fixtureIncoming({ channelId: "web", id: "first", topicId, text: "  关注 executor\n部署情况  " }));
  await aide.receive(fixtureIncoming({ channelId: "web", id: "second", topicId, text: "换个话题" }));
  await aide.settled();
  assert.equal(aide.personal.topics.resource(topicId)!.spec.name, "关注 executor 部署情况");
  const source = aide.personal; await source.start();
  await source.topics.ensure("source-name");
  await source.topics.submit("discovery", { origin: "source", originId: "personal.environments", topicId: "source-name", text: "发现新的需求" });
  await aide.settled();
  assert.equal(source.topics.resource("source-name")!.spec.name, "发现新的需求");
  await aide.close(); aide = new Aide(root, options, pino({ level: "silent" }));
  await aide.start(); await aide.settled();
  assert.equal(aide.personal.topics.get(topicId)!.name, "关注 executor 部署情况");
  assert.equal(aide.personal.topics.get("source-name")!.name, "发现新的需求");
});
