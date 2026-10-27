import { digest } from "../plugins/personal/chief-model.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { webAddress } from "../src/channel/address.ts";
import { fixtureIncoming } from "./address-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { httpChannel } from "../src/api/index.ts";
import { browseTopics } from "../plugins/personal/topic/browse.ts";
import { fakeOptions } from "./fake-harness.ts";
import { defaultDestination } from "../plugins/personal/route/rules.ts";
import { TOPIC_TYPE } from "../plugins/personal/topic/model.ts";

const log = pino({ level: "silent" });

/** @case The system fallback survives concurrent creation and restart; ordinary Topics cannot replace it. */
test("Default Topic is system-maintained, unique and persisted", async t => {
  const root = mkdtempSync(join(tmpdir(), "aide-default-"));
  const options = fakeOptions({ async execute() { throw new Error("No work expected"); } }, root);
  let aide = new Aide(root, options, log);
  const server = httpChannel(aide, log);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await aide.close(); rmSync(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(base, { redirect: "manual" })).status, 200);
  assert.equal(aide.topics.list().length, 0);
  const resources = aide.runtime.plugins.resourceClient("personal");
  const context = { resources, logger: { info() {} } };
  await assert.rejects(resources.create(TOPIC_TYPE, { name: digest("default"), spec: { id: "ordinary" }, status: { receipts: [] } }), /reserved/);
  const destinations = await Promise.all(Array.from({ length: 8 }, () => defaultDestination(context)));
  assert.ok(destinations.every(d => d.uid === destinations[0]!.uid));
  const fallback = aide.topics.resource("default")!;
  assert.deepEqual(browseTopics(aide.topics).pinned.map(t => t.id), ["default"]);
  assert.equal(fallback.spec.address, undefined);
  // Opening the reserved Topic through a channel does not replace its identity, name or address.
  assert.deepEqual(await aide.topics.ensure("default", webAddress("private"), "Private"), fallback);
  const ordinary = await aide.topics.ensure("private", webAddress("private"));
  await assert.rejects(resources.replace(ordinary, { ...ordinary.spec, default: true }, ordinary.status), /reserved/);
  await assert.rejects(resources.replace(fallback, { ...fallback.spec, default: false }, fallback.status), /reserved/);
  await assert.rejects(resources.replace(fallback, { ...fallback.spec, parentRef: resourceRef(ordinary) }, fallback.status), /remain a root/);
  await assert.rejects(resources.replace(ordinary, { ...ordinary.spec, parentRef: resourceRef(fallback) }, ordinary.status), /parent unavailable/);
  await assert.rejects(resources.create(TOPIC_TYPE, { name: "duplicate", spec: { id: "duplicate", default: true }, status: { receipts: [] } }), /reserved/);
  await assert.rejects(resources.delete(TOPIC_TYPE, fallback.metadata.name), /cannot be deleted/);
  const removed = await fetch(base + "/topics/default", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topicId: "private", enabled: true }) });
  assert.equal(removed.status, 404);
  const bundle = await fetch(base + "/app.js");
  assert.equal(bundle.status, 200);
  assert.doesNotMatch(await bundle.text(), /设为默认主题/);
  const home = await fetch(base, { redirect: "manual" });
  assert.equal(home.status, 302);
  assert.equal(new URL(home.headers.get("location")!, base).searchParams.get("topic"), "default");
  assert.equal((await fetch(base + "/?topic=private", { redirect: "manual" })).status, 200);
  await aide.close(); aide = new Aide(root, options, log);
  assert.equal(aide.topics.resource("default")!.metadata.uid, fallback.metadata.uid);
  assert.deepEqual(browseTopics(aide.topics).pinned.map(t => t.id), ["default"]);
});

/** @case Default receives unmatched Inputs; explicit topic rules bypass it and redelivery remains idempotent. */
test("Default receives unmatched Inputs while hinted and Channel Inputs go directly to their topic", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-default-route-"));
  const aide = new Aide(root, fakeOptions({ async chief(prompt) {
    assert.doesNotMatch(prompt, /Candidates:/); return "processed";
  }, async execute() { throw new Error("No work expected"); } }, root), log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.personal.topics.ensure("private");
  await aide.personal.topics.ensure("group");
  await aide.topics.ensure("default");
  const source = aide.personal; await aide.start();
  for (const text of ["needs-contact", "specific", "irrelevant"]) {
    await source.topics.submit(text, { origin: "source", originId: "personal.environments", text });
    await aide.settled();
  }
  assert.deepEqual(aide.personal.topics.inputs("default").map((i) => i.metadata.name), ["needs-contact", "specific", "irrelevant"]);
  assert.deepEqual(aide.personal.topics.inputs("group").map((i) => i.metadata.name), []);
  await source.topics.submit("hint", { origin: "source", originId: "personal.environments", topicId: "group", text: "explicit destination" });
  await aide.settled();
  assert.ok(aide.personal.topics.input("hint", "group"));
  assert.equal(aide.personal.topics.input("hint", "default"), undefined);
  await aide.receive(fixtureIncoming({ channelId: "web", id: "channel", topicId: "group", text: "channel input" }));
  await aide.settled();
  const group = aide.personal.topics;
  const channel = group.inputs("group").find((input) => input.spec.text === "channel input")!;
  assert.equal(aide.personal.topics.input(channel.metadata.name, "default"), undefined);
  const before = aide.outputs().length;
  await aide.receive(fixtureIncoming({ channelId: "web", id: "channel", topicId: "group", text: "channel input" }));
  await aide.settled(); assert.equal(aide.outputs().length, before);
});

/** @case A direct Web message can initialize Default without claiming it as a channel-owned Topic. */
test("Opening Default before any fallback input preserves its system identity and replies to the Input", async t => {
  const root = mkdtempSync(join(tmpdir(), "aide-default-open-"));
  const aide = new Aide(root, fakeOptions({ async chief() { return "received"; }, async route() { throw new Error("Explicit Topic needs no model routing"); }, async execute() { throw new Error("No Work"); } }, root), log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.receive(fixtureIncoming({ channelId: "web", id: "hello", topicId: "default", text: "hello" }));
  await aide.settled();
  const fallback = aide.topics.resource("default")!;
  assert.equal(fallback.spec.default, true);
  assert.equal(fallback.spec.name, "Default");
  assert.equal(fallback.spec.address, undefined);
  assert.equal(aide.topics.inputs("default").length, 1);
  assert.deepEqual(aide.outputs().map(output => output.target), [webAddress("default")]);
});
