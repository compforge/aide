import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import pino from "pino";
import { Aide } from "../plugins/personal/aide.ts";
import { fakeOptions } from "./fake-harness.ts";
import { httpChannel } from "../src/channel/http.ts";

test("HTTP input -> model routing -> persisted task -> execution -> outgoing message", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aide-channel-"));
  const requests: string[] = [];
  const log = pino({ level: "silent" });
  const aide = new Aide(dir, fakeOptions({
    route: async () => ({ action: "create", kind: "task", workId: null, title: "工作总结", instruction: "读取今日工作并总结", trigger: null, response: "开始整理" }),
    execute: async () => ({ action: "done", summary: "Read work log", notification: "今天完成了三件事", question: null, nextAt: null }),
  }, dir, requests), log);
  const server = httpChannel(aide, log);
  t.after(async () => {
    await aide.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  aide.start();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.match(await page.text(), /交办事情或回答问题/);
  assert.equal((await (await fetch(`${url}/health`)).json() as { status: string }).status, "ok");
  // A website must not be able to submit work to the local agent through a visitor's browser.
  assert.equal((await fetch(`${url}/messages`, {
    method: "POST", headers: { origin: "https://unrelated.example", "content-type": "application/json" },
    body: JSON.stringify({ id: "foreign", conversationId: "me", text: "do work" }),
  })).status, 403);
  assert.equal((await fetch(`${url}/messages`, { method: "POST", body: "{}" })).status, 415);
  assert.equal(requests.length, 0);
  const response = await fetch(`${url}/messages`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "msg-1", conversationId: "me", text: "总结今日工作" }),
  });
  assert.equal(response.status, 200);
  const ack = await response.json() as { id: string; workId: string };
  await aide.settled();
  const outgoing = await (await fetch(`${url}/messages?conversationId=me&after=${ack.id}`)).json() as { text: string }[];
  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0]?.text, "今天完成了三件事");
  const history = await (await fetch(`${url}/messages?conversationId=me&role=all`)).json() as { role: string; text: string }[];
  assert.equal(history.length, 3);
  assert.deepEqual(history[0], { ...history[0], role: "user", text: "总结今日工作" });
  const works = await (await fetch(`${url}/work?conversationId=me`)).json() as { status: string; id: string }[];
  assert.equal(works[0]?.status, "done");
  assert.equal(works[0]?.id, ack.workId);
  assert.match(requests[1]!, /读取今日工作并总结/);
  assert.equal((await fetch(`${url}/messages?conversationId=me&after=missing`)).status, 400);
  assert.deepEqual(await (await fetch(`${url}/work?conversationId=other`)).json(), []);
});
