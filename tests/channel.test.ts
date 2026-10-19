import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { httpChannel } from "../src/api/index.ts";
import type { InputRequest } from "../src/host/message/types.ts";
import type { InteractionResult } from "../src/host/interaction/types.ts";

test("HTTP accepts Chief input durably and exposes asynchronous failure without replay", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aide-channel-"));
  const requests: string[] = [];
  let routes = 0;
  const log = pino({ level: "silent" });
  const aide = new Aide(dir, fakeOptions({
    chief: async () => { if (++routes === 1) throw new Error("Model failed"); return "今天完成了三件事"; },
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
  assert.match(page.headers.get("content-security-policy")!, /style-src 'self'/);
  assert.match(await page.text(), /交办事情或回答问题/);
  assert.equal((await (await fetch(`${url}/health`)).json() as { status: string }).status, "ok");
  // A website must not be able to submit work to the local agent through a visitor's browser.
  assert.equal((await fetch(`${url}/messages`, {
    method: "POST", headers: { origin: "https://unrelated.example", "content-type": "application/json" },
    body: JSON.stringify({ id: "foreign", sessionId: "me", conversationId: "me", text: "do work" }),
  })).status, 403);
  assert.equal((await fetch(`${url}/messages`, { method: "POST", body: "{}" })).status, 415);
  assert.equal(requests.length, 0);
  const failed = await fetch(`${url}/messages`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "msg-1", sessionId: "me", conversationId: "me", text: "总结今日工作" }),
  });
  assert.equal(failed.status, 200);
  await aide.settled();
  assert.match(aide.messages().at(-1)!.text, /本次处理未完成/);
  assert.equal(aide.works().length, 0);
  const response = await fetch(`${url}/messages`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "msg-2", sessionId: "me", conversationId: "me", text: "总结今日工作" }),
  });
  assert.equal(response.status, 200);
  const ack = await response.json() as { id: string; workId: string };
  await aide.settled();
  const outgoing = await (await fetch(`${url}/messages?conversationId=me&role=all&after=${ack.id}`)).json() as { text: string }[];
  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0]?.text, "今天完成了三件事");
  const history = await (await fetch(`${url}/messages?conversationId=me&role=all`)).json() as { role: string; text: string }[];
  assert.equal(history.length, 4);
  assert.deepEqual(history[0], { ...history[0], role: "user", text: "总结今日工作" });
  const works = await (await fetch(`${url}/work?conversationId=me`)).json() as { status: string; id: string }[];
  assert.deepEqual(works, []);
  assert.equal((await fetch(`${url}/messages?conversationId=me&after=missing`)).status, 400);
  assert.deepEqual(await (await fetch(`${url}/work?conversationId=other`)).json(), []);
});

test("web answers the original Harness interaction and rejects stale or mismatched responses", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aide-interaction-"));
  const log = pino({ level: "silent" });
  let decision: InteractionResult | undefined;
  const options = fakeOptions({
    chief: async () => "已继续",
    execute: async () => { throw new Error("No work expected"); },
  }, dir);
  const aide = new Aide(dir, { ...options, createAdapter: (_target, ports) => {
    const adapter = options.createAdapter(_target);
    const open = adapter.open.bind(adapter);
    adapter.open = async (...args) => {
      decision = await ports.openInteraction({ kind: "hook_trust", harnessName: "Test Harness", hooks: [
        { key: "session_start", source: "test", sourcePath: "/test/hooks.json", trustStatus: "modified", command: "test-hook" },
      ] });
      return open(...args);
    };
    return adapter;
  } }, log);
  const server = httpChannel(aide, log);
  t.after(async () => {
    await aide.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const post = (path: string, value: unknown) => fetch(url + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  });
  const receiving = post("/messages", { id: "interaction-input", sessionId: "me", conversationId: "me", text: "继续" });
  let pending: InputRequest | undefined;
  for (let attempt = 0; attempt < 100 && !pending; attempt++) {
    [pending] = await (await fetch(url + "/interactions")).json() as InputRequest[];
    if (!pending) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(pending, "Adapter startup should publish a pending request");
  assert.equal(decision, undefined);
  assert.equal((await post("/interactions", { messageId: pending.messageId,
    result: { kind: "permission", outcome: "selected", optionId: "allow" } })).status, 400);
  const answer = { messageId: pending.messageId, result: { kind: "hook_trust", outcome: "trusted" } };
  assert.equal((await post("/interactions", answer)).status, 200);
  assert.deepEqual(decision, answer.result);
  assert.equal((await post("/interactions", answer)).status, 409);
  assert.equal((await receiving).status, 200);
  assert.deepEqual(await (await fetch(url + "/interactions")).json(), []);
  const resolved = aide.session("me").core.projection.interactions.get(pending.messageId)?.request;
  assert.equal(resolved?.status, "answered");
  assert.ok(resolved?.responseMessageId);
});

test("conversation navigation lists persisted scopes without creating them and keeps messages/work scoped", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aide-conversation-list-"));
  const log = pino({ level: "silent" });
  const aide = new Aide(dir, fakeOptions({ execute: async () => { throw new Error("Browsing must not execute work"); } }, dir), log);
  const server = httpChannel(aide, log);
  t.after(async () => {
    await aide.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const list = async () => await (await fetch(url + "/conversations")).json() as
    { id: string; title: string; preview: string; updatedAt: string }[];
  assert.deepEqual(await list(), []);
  await fetch(url + "/?conversation=unsent");
  assert.equal(aide.sessions().flatMap((scope) => scope.conversations.list()).length, 0);
  const group = "feishu:app:群 & #1";
  const base = Date.now() + 60_000;
  const at = (offset: number) => new Date(base + offset).toISOString();
  aide.session("me").conversations.archive("me", [{ id: "m1", conversationId: "me", at: at(0), role: "user", text: "默认会话问题", workId: null }]);
  aide.session(group).conversations.archive(group, [
    { id: "m2", conversationId: group, at: at(1), role: "user", text: "检查 <项目>\n进展", workId: null },
    { id: "m3", conversationId: group, at: at(2), role: "aide", text: "群会话的回复", workId: null },
  ]);
  aide.session("source:requirements").conversations.submit("source-observation", { conversationId: "source:requirements", origin: "source", text: "private observation" }, { phase: "done" });
  (await aide.work("work-only").create({ kind: "routine", title: "定期检查", instruction: "check", trigger: { cron: null, timezone: "UTC", event: "changed" } }));
  const task = (await aide.work(group).create({ kind: "task", title: "检查项目", instruction: "check", trigger: null }));
  const before = aide.sessions().flatMap((scope) => scope.conversations.list());
  const summaries = await list();
  assert.deepEqual(summaries.map((item) => item.id), [group, "me", "work-only", "source:requirements"]);
  assert.deepEqual(summaries[0], { id: group, sessionId: group, title: "检查 <项目> 进展", preview: "群会话的回复", updatedAt: at(2) });
  assert.equal(summaries.find((item) => item.id === "source:requirements")?.preview, "");
  assert.ok(!JSON.stringify(summaries).includes("private observation"));
  assert.deepEqual(aide.sessions().flatMap((scope) => scope.conversations.list()), before);
  const messages = await (await fetch(url + "/messages?role=all&conversationId=" + encodeURIComponent(group))).json() as { conversationId: string }[];
  assert.equal(messages.length, 2);
  assert.ok(messages.every((message) => message.conversationId === group));
  const works = await (await fetch(url + "/work?conversationId=" + encodeURIComponent(group))).json() as { id: string }[];
  assert.deepEqual(works.map((item) => item.id), [task.id]);
  assert.deepEqual(await (await fetch(url + "/work?conversationId=me")).json(), []);
  assert.equal((await fetch(url + "/conversations", { headers: { origin: "https://unrelated.example" } })).status, 403);
});

/** @case Web deletion is scoped and revision checked, preserves messages and stops future Work dispatch. */
test("Web deletes Tasks and Routines through WorkService and preserves other conversations", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aide-web-delete-"));
  const requests: string[] = [];
  const log = pino({ level: "silent" });
  const aide = new Aide(dir, fakeOptions({ execute: async () => { throw new Error("Deleted work must not execute"); } }, dir, requests), log);
  const server = httpChannel(aide, log);
  t.after(async () => {
    await aide.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  const group = "feishu:app:群 & #1";
  const work = aide.work(group);
  const initialTask = await work.create({ kind: "task", title: "检查项目", instruction: "check", trigger: null });
  const task = await work.update(initialTask.id, { revision: initialTask.revision, action: "pause" });
  const routine = await work.create({ kind: "routine", title: "监控内存", instruction: "check", trigger: { cron: null, timezone: "UTC", event: "memory.changed" } });
  const foreign = await aide.work("other").create({ kind: "routine", title: "其他会话", instruction: "check", trigger: { cron: null, timezone: "UTC", event: "memory.changed" } });
  await aide.session(group).store.save(routine, [{ id: "retained-reply", conversationId: group, at: new Date().toISOString(), role: "aide", text: "已建立监控", workId: routine.id }]);
  await aide.start(); await aide.settled();
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const remove = (id: string, revision: number, conversationId = group) => fetch(base + "/work/delete", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, revision, conversationId }),
  });
  for (const [path, type] of [["/app.js", "javascript"], ["/style.css", "text/css"]]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type")!.includes(type!));
    assert.ok((await response.text()).length > 0);
  }
  assert.equal((await fetch(base + "/work/delete", { method: "POST", body: "{}" })).status, 415);
  assert.equal((await fetch(base + "/work/delete", { method: "POST", headers: { "content-type": "application/json", origin: "https://unrelated.example" }, body: JSON.stringify({ id: task.id, revision: task.revision, sessionId: group, conversationId: group }) })).status, 403);
  assert.equal((await remove(task.id, 0)).status, 400);
  assert.equal((await remove(foreign.id, foreign.revision)).status, 404);
  assert.equal((await remove(task.id, initialTask.revision)).status, 409);
  assert.equal(work.list().length, 2);
  for (const item of [task, routine]) {
    const response = await remove(item.id, item.revision);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: true });
    assert.equal((await remove(item.id, item.revision)).status, 404);
  }
  await aide.settled();
  assert.deepEqual(await (await fetch(base + "/work?conversationId=" + encodeURIComponent(group))).json(), []);
  assert.deepEqual(aide.work("other").list().map((item) => item.id), [foreign.id]);
  assert.equal(aide.messages().find((item) => item.id === "retained-reply")?.text, "已建立监控");
  assert.equal(await aide.event({ id: "after-delete", sessionId: group, conversationId: group, name: "memory.changed", text: "changed" }), 0);
  await aide.settled();
  assert.equal(requests.length, 0);
});
