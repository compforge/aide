import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { httpChannel } from "../src/api/index.ts";
import { conversationList } from "../src/channel/view.ts";
import { fakeOptions } from "./fake-harness.ts";

const log = pino({ level: "silent" });

/** @case Default contact is globally unique, survives restart, and never overrides an explicit Web destination. */
test("Default conversation selection is serialized across Sessions and persisted", async (t) => {
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
  const select = (conversationId: string, enabled = true) => fetch(base + "/conversations/default", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId, enabled }),
  });
  assert.equal((await fetch(base, { redirect: "manual" })).status, 200);
  assert.equal(aide.sessions().length, 0);
  assert.equal((await select("missing")).status, 404);
  const a = "lark:private & #1", b = "web:second";
  await aide.session(a).conversations.ensure();
  await aide.session(b).conversations.ensure();
  assert.equal((await select(a)).status, 200);
  const home = await fetch(base, { redirect: "manual" });
  assert.equal(home.status, 302);
  assert.equal(new URL(home.headers.get("location")!, base).searchParams.get("conversation"), a);
  assert.equal((await fetch(base + "/?conversation=" + encodeURIComponent(b), { redirect: "manual" })).status, 200);
  // Observers must never see two defaults, even while requests are switching across Sessions.
  const counts: number[] = [];
  const stop = aide.subscribe(() => counts.push(conversationList(aide).filter((c) => c.default).length));
  await Promise.all([aide.setDefaultConversation(b, true), aide.setDefaultConversation(a, true), aide.setDefaultConversation(b, true)]);
  stop();
  assert.ok(counts.length > 0 && counts.every((count) => count <= 1));
  assert.deepEqual(conversationList(aide).filter((c) => c.default).map((c) => c.id), [b]);
  assert.equal(aide.session(b).conversations.get(b)!.trigger!.enabled, false);
  assert.equal(aide.messages().length, 0);
  await assert.rejects(aide.setDefaultConversation("missing", true), /does not exist/);
  assert.equal(conversationList(aide).find((c) => c.default)!.id, b);
  // A failed request must not poison the selector's queue.
  assert.equal((await select(a)).status, 200);
  assert.equal((await select(a, false)).status, 200);
  assert.equal((await fetch(base, { redirect: "manual" })).status, 200);
  assert.equal((await select(a)).status, 200);
  await aide.close(); aide = new Aide(root, options, log);
  assert.deepEqual(conversationList(aide).filter((c) => c.default).map((c) => c.id), [a]);
  const c = aide.session(a).conversations.resource(a)!;
  await aide.session(a).plugins.resourceClient("personal").delete(c, c.metadata.name);
  assert.equal(conversationList(aide).filter((c) => c.default).length, 0);
});

/** @case Default receives all Inputs; rule matches still receive the same fact and overlap is idempotent. */
test("Default receives unscoped, hinted and Channel Inputs without semantic filtering", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-default-route-"));
  const aide = new Aide(root, fakeOptions({ async chief(prompt) {
    assert.doesNotMatch(prompt, /Candidates:/); return "processed";
  }, async execute() { throw new Error("No work expected"); } }, root), log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.session("private").conversations.ensure();
  await aide.session("group").conversations.ensure();
  await aide.setDefaultConversation("private", true);
  const source = aide.session("source"); await aide.start();
  for (const text of ["needs-contact", "specific", "irrelevant"]) {
    await source.conversations.submit(text, { origin: "source", originId: "personal.environments", text });
    await aide.settled();
  }
  assert.deepEqual(aide.session("private").conversations.get("private")!.inputIds, ["needs-contact", "specific", "irrelevant"]);
  assert.deepEqual(aide.session("group").conversations.get("group")!.inputIds, []);
  await source.conversations.submit("hint", { origin: "source", originId: "personal.environments", sessionId: "group", text: "explicit destination" });
  await aide.settled();
  for (const id of ["private", "group"]) assert.ok(aide.session(id).conversations.get(id)!.inputIds.includes("hint"));
  await aide.receive({ channelId: "web", id: "channel", sessionId: "group", text: "channel input" });
  await aide.settled();
  const group = aide.session("group").conversations;
  const channel = group.inputs("group").find((input) => input.spec.text === "channel input")!;
  assert.equal(aide.session("private").conversations.input(channel.metadata.name)!.status.phase, "done");
  const before = aide.messages().length;
  await aide.receive({ channelId: "web", id: "channel", sessionId: "group", text: "channel input" });
  await aide.settled(); assert.equal(aide.messages().length, before);
});
