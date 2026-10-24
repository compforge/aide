import { deliver } from "../plugins/personal/route/delivery.ts";
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
import { topicList } from "../src/channel/view.ts";
import { fakeOptions } from "./fake-harness.ts";

const log = pino({ level: "silent" });

/** @case Default contact is globally unique, survives restart, and never overrides an explicit Web destination. */
test("Default topic selection is application-wide, serialized and persisted", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-default-"));
  const options = fakeOptions({ async execute() { throw new Error("No work expected"); } }, root);
  let aide = new Aide(root, options, log);
  const server = httpChannel(aide, log);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await aide.close(); rmSync(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const select = (topicId: string, enabled = true) => fetch(base + "/topics/default", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topicId, enabled }),
  });
  assert.equal((await fetch(base, { redirect: "manual" })).status, 200);
  assert.equal(aide.runtime.plugins.listInstances().length, 1);
  assert.equal((await select("missing")).status, 404);
  const a = "lark:private & #1", b = "web:second";
  await aide.personal.topics.ensure(a);
  await aide.personal.topics.ensure(b);
  assert.equal((await select(a)).status, 200);
  const home = await fetch(base, { redirect: "manual" });
  assert.equal(home.status, 302);
  assert.equal(new URL(home.headers.get("location")!, base).searchParams.get("topic"), a);
  assert.equal((await fetch(base + "/?topic=" + encodeURIComponent(b), { redirect: "manual" })).status, 200);
  // Selection replaces the marker atomically; both topics and explicit destinations remain.
  assert.equal((await select(b)).status, 200);
  assert.deepEqual(topicList(aide).filter(c => c.default).map(c => c.id), [b]);
  assert.ok(aide.topics.resource(a));
  await Promise.all([aide.setDefaultTopic(a, true), aide.setDefaultTopic(b, true), aide.setDefaultTopic(a, true)]);
  await assert.rejects(aide.setDefaultTopic(a, false), /Select another/);
  assert.deepEqual(topicList(aide).filter(c => c.default).map(c => c.id), [a]);
  await aide.close(); aide = new Aide(root, options, log);
  assert.deepEqual(topicList(aide).filter(c => c.default).map(c => c.id), [a]);
  const c = aide.personal.topics.resource(a)!;
  await assert.rejects(aide.personal.plugins.resourceClient("personal").delete(c, c.metadata.name), /cannot be deleted/);
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
  await aide.setDefaultTopic("private", true);
  const source = aide.personal; await aide.start();
  for (const text of ["needs-contact", "specific", "irrelevant"]) {
    await source.topics.submit(text, { origin: "source", originId: "personal.environments", text });
    await aide.settled();
  }
  assert.deepEqual(aide.personal.topics.inputs("private").map((i) => i.metadata.name), ["needs-contact", "specific", "irrelevant"]);
  assert.deepEqual(aide.personal.topics.inputs("group").map((i) => i.metadata.name), []);
  await source.topics.submit("hint", { origin: "source", originId: "personal.environments", topicId: "group", text: "explicit destination" });
  await aide.settled();
  assert.ok(aide.personal.topics.input("hint", "group"));
  assert.equal(aide.personal.topics.input("hint", "private"), undefined);
  await aide.receive(fixtureIncoming({ channelId: "web", id: "channel", topicId: "group", text: "channel input" }));
  await aide.settled();
  const group = aide.personal.topics;
  const channel = group.inputs("group").find((input) => input.spec.text === "channel input")!;
  assert.equal(aide.personal.topics.input(channel.metadata.name, "private"), undefined);
  const before = aide.outputs().length;
  await aide.receive(fixtureIncoming({ channelId: "web", id: "channel", topicId: "group", text: "channel input" }));
  await aide.settled(); assert.equal(aide.outputs().length, before);
});

/** @case A private-chat leaf can replace Default without rewriting history or interrupting its previous Chief. */
test("Selecting a grouped leaf detaches it only when quiet and preserves facts, identity and Work", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-default-leaf-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("No work expected"); } }, home), log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = aide.runtime.plugins.resourceClient("personal");
  const topics = aide.topics;
  await topics.ensure("old-default"); await aide.setDefaultTopic("old-default", true);
  const parent = await topics.ensure("parent");
  const leaf = await topics.ensure("private", webAddress("private"), "My private channel");
  const sibling = await topics.ensure("sibling");
  await resources.replace(leaf, { ...leaf.spec, parentRef: resourceRef(parent) }, { ...leaf.status, summary: "Preserve my preferences" });
  await resources.replace(sibling, { ...sibling.spec, parentRef: resourceRef(parent) }, sibling.status);
  const work = await aide.work(parent.spec.id).create({ kind: "task", title: "Existing work", instruction: "Keep progressing", trigger: null });
  const input = await topics.submit("earlier", { origin: "channel", originId: "web", topicId: "private", text: "Earlier request", source: webAddress("private") });
  await deliver({ resources, logger: { info() {} } }, input, [leaf.metadata], "private channel");
  const assigned = topics.inputStore.get("earlier")!;
  assert.ok(assigned.status.assess![parent.metadata.uid]);
  const originalDefault = topics.resource("old-default")!;
  await assert.rejects(aide.setDefaultTopic("private", true), /pending Input/);
  assert.deepEqual(topics.resource("old-default"), originalDefault);
  assert.equal(topics.resource("private")!.spec.parentRef!.uid, parent.metadata.uid);

  await resources.patchStatus(assigned, { assess: { [parent.metadata.uid]: { ...assigned.status.assess![parent.metadata.uid]!, completedAt: new Date().toISOString() } } });
  const completed = topics.inputStore.get("earlier")!;
  await resources.patchStatus(topics.resource("parent")!, { execution: { id: "busy", startedAt: new Date().toISOString() } });
  await assert.rejects(aide.setDefaultTopic("private", true), /processing is active/);
  await resources.patchStatus(topics.resource("parent")!, { execution: null, weaveLock: "grouping" });
  await assert.rejects(aide.setDefaultTopic("private", true), /processing is active/);
  await resources.patchStatus(topics.resource("parent")!, { weaveLock: null });
  await resources.patchStatus(topics.resource("private")!, { weaveLock: "grouping" });
  await assert.rejects(aide.setDefaultTopic("private", true), /being organized/);
  await resources.patchStatus(topics.resource("private")!, { weaveLock: null });
  await assert.rejects(aide.setDefaultTopic("parent", true), /cannot have children/);
  assert.deepEqual(topics.resource("old-default"), originalDefault);

  const before = topics.resource("private")!;
  await aide.setDefaultTopic("private", true);
  const selected = topics.resource("private")!;
  assert.equal(selected.metadata.uid, leaf.metadata.uid);
  assert.equal(selected.spec.parentRef, undefined);
  assert.equal(selected.spec.default, true);
  assert.deepEqual(selected.spec.address, leaf.spec.address);
  assert.equal(selected.spec.name, leaf.spec.name);
  assert.deepEqual(selected.status, before.status);
  assert.equal(topics.resource("old-default")!.spec.default, false);
  assert.equal(topics.resource("sibling")!.spec.parentRef!.uid, parent.metadata.uid);
  assert.deepEqual(topics.inputStore.get("earlier"), completed);
  assert.equal(aide.works().find(w => w.id === work.id)!.topicId, "parent");
  assert.equal(topics.inputs("private").length, 1);
  await aide.setDefaultTopic("private", true);
  assert.deepEqual(topics.resource("private"), selected);

  const next = await topics.submit("later", { origin: "channel", originId: "web", topicId: "private", text: "New request" });
  await deliver({ resources, logger: { info() {} } }, next, [selected.metadata], "private channel");
  assert.deepEqual(Object.keys(topics.inputStore.get("later")!.status.assess!), [leaf.metadata.uid]);
});
