import { fixtureAddress } from "./address-fixture.ts";
import { seedInput } from "./conversation-fixture.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { httpChannel } from "../src/api/index.ts";
import type { InputRequest } from "../src/host/message/types.ts";
import type { ApprovalResult } from "../src/host/approval/types.ts";

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
  assert.match(aide.outputs().at(-1)!.text, /本次处理未完成/);
  assert.equal(aide.works().length, 0);
  const cursor = aide.outputs().at(-1)!.id;
  const response = await fetch(`${url}/messages`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "msg-2", sessionId: "me", conversationId: "me", text: "总结今日工作" }),
  });
  assert.equal(response.status, 200);
  const ack = await response.json() as { inputId: string; at: string };
  await aide.settled();
  const outgoing = await (await fetch(`${url}/messages?conversationId=me&role=all&after=${cursor}`)).json() as { text: string }[];
  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0]?.text, "今天完成了三件事");
  const history = await (await fetch(`${url}/messages?conversationId=me&role=all`)).json() as { role: string; text: string }[];
  assert.equal(history.length, 2);
  assert.ok(aide.personal.conversations.inputStore.get(ack.inputId));
  assert.ok(history.every((message) => message.role === "aide"));
  const works = await (await fetch(`${url}/work?conversationId=me`)).json() as { status: string; id: string }[];
  assert.deepEqual(works, []);
  assert.equal((await fetch(`${url}/messages?conversationId=me&after=missing`)).status, 400);
  assert.deepEqual(await (await fetch(`${url}/work?conversationId=other`)).json(), []);
});

test("web answers the original Harness approval and rejects stale or mismatched responses", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aide-interaction-"));
  const log = pino({ level: "silent" });
  let decision: ApprovalResult | undefined;
  const options = fakeOptions({
    chief: async () => "已继续",
    execute: async () => { throw new Error("No work expected"); },
  }, dir);
  const aide = new Aide(dir, { ...options, createAdapter: (_target, ports) => {
    const adapter = options.createAdapter(_target);
    const open = adapter.open.bind(adapter);
    adapter.open = async (...args) => {
      decision = await ports.openApproval({ kind: "hook_trust", harnessName: "Test Harness", hooks: [
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
    [pending] = await (await fetch(url + "/approvals")).json() as InputRequest[];
    if (!pending) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(pending, "Adapter startup should publish a pending request");
  assert.equal(decision, undefined);
  assert.equal((await post("/approvals", { messageId: pending.messageId,
    result: { kind: "question", outcome: "answered", text: "yes" } })).status, 400);
  assert.equal((await post("/interactions", { messageId: pending.messageId })).status, 404);
  assert.equal((await post("/approvals", { messageId: pending.messageId,
    result: { kind: "permission", outcome: "selected", optionId: "allow" } })).status, 400);
  const answer = { messageId: pending.messageId, result: { kind: "hook_trust", outcome: "trusted" } };
  assert.equal((await post("/approvals", answer)).status, 200);
  assert.deepEqual(decision, answer.result);
  assert.equal((await post("/approvals", answer)).status, 409);
  assert.equal((await receiving).status, 200);
  assert.deepEqual(await (await fetch(url + "/approvals")).json(), []);
  const resolved = aide.personal.core.executions.approval(pending.messageId);
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
    { id: string; name: string; preview: string; updatedAt: string; taskCount: number; routineCount: number }[];
  assert.deepEqual(await list(), []);
  await fetch(url + "/?conversation=unsent");
  assert.equal(aide.conversations.list().length, 0);
  const group = "lark:app:群 & #1";
  const base = Date.now() + 60_000;
  const at = (offset: number) => new Date(base + offset).toISOString();
  await seedInput(aide.personal.conversations, "m1", { conversationId: "me", origin: "channel", originId: "web", text: "默认会话问题" }, { phase: "done" });
  await seedInput(aide.personal.conversations, "group-first", { conversationId: group, origin: "channel", originId: "web", text: "检查 <项目>\n进展" }, { phase: "done", outputs: [
    { id: "m3", conversationId: group, at: at(2), text: "群会话的回复", workId: null },
  ] });
  await seedInput(aide.personal.conversations, "source-observation", { conversationId: "source:requirements", origin: "source", originId: "personal.environments", text: "private observation" }, { phase: "done" });
  (await aide.work("work-only").create({ kind: "routine", title: "定期检查", instruction: "check", trigger: { cron: null, timezone: "UTC", event: "changed" } }));
  const task = (await aide.work(group).create({ kind: "task", title: "检查项目", instruction: "check", trigger: null }));
  const before = aide.conversations.list();
  const summaries = await list();
  assert.deepEqual(summaries.map((item) => item.id), [group, "work-only", "source:requirements", "me"]);
  assert.deepEqual(summaries[0], { id: group, uid: aide.personal.conversations.resource(group)!.metadata.uid, revision: aide.personal.conversations.get(group)!.revision, sessionId: group, default: false, trigger: { enabled: false, intervalSeconds: 3600 }, name: "检查 <项目> 进展", preview: "群会话的回复", updatedAt: at(2), taskCount: 1, routineCount: 0 });
  assert.deepEqual(summaries.map((item) => [item.taskCount, item.routineCount]), [[1, 0], [0, 1], [0, 0], [0, 0]]);
  assert.equal(summaries.find((item) => item.id === "source:requirements")?.preview, "");
  assert.equal(summaries.find((item) => item.id === "source:requirements")?.name, "private observation");
  assert.deepEqual(aide.conversations.list(), before);
  const messages = await (await fetch(url + "/messages?role=all&conversationId=" + encodeURIComponent(group))).json() as { conversationId: string }[];
  assert.equal(messages.length, 1);
  assert.ok(messages.every((message) => message.conversationId === group));
  const works = await (await fetch(url + "/work?conversationId=" + encodeURIComponent(group))).json() as { id: string }[];
  assert.deepEqual(works.map((item) => item.id), [task.id]);
  assert.deepEqual(await (await fetch(url + "/work?conversationId=me")).json(), []);
  assert.equal((await fetch(url + "/conversations", { headers: { origin: "https://unrelated.example" } })).status, 403);
  await aide.work(group).delete(task.id, task.revision);
  assert.equal((await list()).find((item) => item.id === group)?.taskCount, 0);
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
  const group = "lark:app:群 & #1";
  await aide.personal.conversations.ensure(group, fixtureAddress(group));
  const work = aide.work(group);
  const initialTask = await work.create({ kind: "task", title: "检查项目", instruction: "check", trigger: null });
  const task = await work.appendInput(initialTask.id, { action: "pause", text: "暂停" });
  const routine = await work.create({ kind: "routine", title: "监控内存", instruction: "check", trigger: { cron: null, timezone: "UTC", event: "memory.changed" } });
  const foreign = await aide.work("other").create({ kind: "routine", title: "其他会话", instruction: "check", trigger: { cron: null, timezone: "UTC", event: "memory.changed" } });
  await aide.personal.store.save(routine, [{ id: "retained-reply", conversationId: group, text: "已建立监控", workId: routine.id }]);
  await aide.start(); await aide.settled();
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const remove = (id: string, revision: number, conversationId = group) => fetch(base + "/work/delete", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, revision, conversationId }),
  });
  for (const [path, type] of [["/app.js", "javascript"], ["/app.css", "text/css"], ["/persons.js", "javascript"], ["/persons.css", "text/css"]]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type")!.includes(type!));
    assert.ok((await response.text()).length > 0);
  }
  // Image responses must preserve bytes; decoding these assets as UTF-8 corrupts the icon.
  for (const [path, file, type] of [
    ["/favicon.ico", "favicon.ico", "image/vnd.microsoft.icon"],
    ["/icon.png", "aide.png", "image/png"],
    ["/apple-touch-icon.png", "apple-touch-icon.png", "image/png"],
  ] as const) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), type);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(new URL(`../src/web/assets/${file}`, import.meta.url)));
  }
  for (const path of ["/", "/people"]) {
    const response = await fetch(base + path);
    assert.match(response.headers.get("content-security-policy")!, /img-src 'self'/);
    const html = await response.text();
    assert.match(html, /rel="icon" href="\/favicon.ico"/);
    assert.match(html, /rel="apple-touch-icon" href="\/apple-touch-icon.png"/);
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
  assert.equal(aide.outputs().find((item) => item.id === "retained-reply")?.text, "已建立监控");
  assert.equal(await aide.event({ id: "after-delete", sessionId: group, conversationId: group, name: "memory.changed", text: "changed" }), 0);
  await aide.settled();
  assert.equal(requests.length, 0);
});
