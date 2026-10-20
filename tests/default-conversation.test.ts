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
  const a = "feishu:private & #1", b = "web:second";
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

/** @case Default is an AI-selected contact, not an automatic sink for unmatched observations. */
test("Routing offers the default contact but preserves specific destinations and silence", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-default-route-"));
  let routes = 0;
  const aide = new Aide(root, fakeOptions({ async chief(prompt) {
    if (!prompt.includes("Candidates:")) return "processed";
    routes++;
    const candidates = JSON.parse(prompt.split("Candidates: ")[1]!) as { id: string; default: boolean }[];
    assert.deepEqual(candidates.filter((c) => c.default).map((c) => c.id), ["private"]);
    assert.match(prompt, /Ignore irrelevant or unimportant observations/);
    const input = JSON.parse(prompt.split("Input: ")[1]!.split("\nCandidates:")[0]!) as { text: string };
    return JSON.stringify({ conversationIds: input.text === "irrelevant" ? [] : input.text === "specific" ? ["group"] : ["private"], reason: "fixture routing decision" });
  }, async execute() { throw new Error("No work expected"); } }, root), log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.session("private").conversations.ensure();
  await aide.session("group").conversations.ensure();
  await aide.setDefaultConversation("private", true);
  const source = aide.session("source"); await aide.start();
  for (const text of ["needs-contact", "specific", "irrelevant"]) {
    await source.conversations.submit(text, { origin: "source", text });
    await aide.settled();
  }
  assert.equal(routes, 3);
  assert.deepEqual(aide.session("private").conversations.get("private")!.inputIds, ["needs-contact"]);
  assert.deepEqual(aide.session("group").conversations.get("group")!.inputIds, ["specific"]);
  assert.equal(source.conversations.inputStore.get("irrelevant")!.status.routing!.phase, "ignored");
  await source.conversations.submit("hint", { origin: "source", sessionId: "group", text: "explicit destination" });
  await aide.settled();
  assert.equal(routes, 3);
  assert.ok(aide.session("group").conversations.get("group")!.inputIds.includes("hint"));
});
