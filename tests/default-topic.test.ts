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
  // Once selected, Default remains the permanent independent root.
  await assert.rejects(aide.setDefaultTopic(b, true), /permanent/);
  await assert.rejects(aide.setDefaultTopic(a, false), /permanent/);
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
