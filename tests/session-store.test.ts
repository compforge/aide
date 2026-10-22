import { resourceHome } from "../src/host/resource/storage.ts";
import { definition } from "./fixtures/resource-definition.ts";
import { spyOn } from "bun:test";
import * as fs from "node:fs";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionStore } from "../src/host/store/store.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { preparePluginDataDirectories } from "../src/host/plugin/data.ts";

test("Execution journals reopen independent resource contexts without creating a main context", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-contexts-"));
  const store = new SessionStore(root);
  const first = store.createSession({ cwd: join(root, "code-a") });
  const second = store.createSession({ cwd: join(root, "code-b") });
  assert.deepEqual(first.meta.contexts, {});
  first.setHarnessTarget("coding", { harnessTargetId: "coding", harness: "codex" });
  for (const contextId of ["resource-one", "resource-two"]) {
    first.setExecutionContext(contextId, { contextId, historyAfterSeq: 7, harnessSessions: {} });
    first.setContextHarnessSession(contextId, "coding", { harness: "codex", harnessSessionId: contextId,
      resumeState: { version: 1, data: { id: contextId } }, contextAfterSeq: 9 });
  }
  const event = first.appendEvent({ kind: "user_message", source: { type: "user" }, contextId: "resource-two", invocationId: "invocation-two",
    payload: { messageId: "message-two", content: [{ type: "text", text: "保留执行历史" }] } });
  const reopened = new SessionStore(root).openSession(first.id);
  t.after(async () => {
    for (const journal of [first, second, reopened]) await journal.closeLogs();
    rmSync(root, { recursive: true, force: true });
  });
  assert.deepEqual(reopened.meta.contexts, first.meta.contexts);
  assert.equal(reopened.meta.contexts["resource-one"]!.harnessSessions.coding!.harnessSessionId, "resource-one");
  assert.equal(reopened.meta.contexts["resource-two"]!.historyAfterSeq, 7);
  assert.equal(reopened.meta.contexts["resource-two"]!.harnessSessions.coding!.contextAfterSeq, 9);
  assert.equal(reopened.ledger.read()[0]!.eventId, event.eventId);
  assert.deepEqual(reopened.projection.messages.get("message-two"), first.projection.messages.get("message-two"));
  assert.deepEqual(new Set(store.listSessions().map(s => s.aideSessionId)), new Set([first.id, second.id]));
  assert.throws(() => store.openSession("../outside"), /path separators/);
  const data = preparePluginDataDirectories(root, { pluginId: "tests/plugin", pluginInstanceId: "default" });
  assert.equal(data.global, join(root, "plugins", "tests%2Fplugin"));
  assert.equal(data.instance, join(data.global, "instances", "default"));
  assert.equal("session" in data, false);
  assert.equal(existsSync(join(root, "projects")), false);
});

test("Session liveness and cleanup use the flat directory after cwd changes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-session-cleanup-"));
  const store = new SessionStore(root);
  const active = store.createSession({ cwd: join(root, "code-a") });
  const idle = store.createSession({ cwd: join(root, "code-b") });
  t.after(async () => {
    active.releaseLock();
    await active.closeLogs(); await idle.closeLogs();
    rmSync(root, { recursive: true, force: true });
  });
  const type = { apiVersion: "tests.dev/v1", kind: "Record" };
  const activeResources = new PluginResourceStore({ home: resourceHome(active.dir), pluginInstanceId: "test" });
  const idleResources = new PluginResourceStore({ home: resourceHome(idle.dir), pluginInstanceId: "test" });
  activeResources.storage.register("test", [definition(type)]);
  activeResources.create({ type, name: "active", spec: {} });
  idleResources.create({ type, name: "idle", spec: {} });
  active.updateMeta({ cwd: join(root, "code-c"), updatedAt: "2000-01-01T00:00:00.000Z" });
  idle.updateMeta({ updatedAt: "2000-01-01T00:00:00.000Z" });
  assert.equal(active.acquireLock(), true);
  assert.equal(store.isSessionActive(active.meta), true);
  const result = store.cleanSessions({ before: new Date("2001-01-01T00:00:00.000Z") });
  assert.deepEqual(result.removed.map((s) => s.aideSessionId), [idle.id]);
  assert.deepEqual(result.skippedActive.map((s) => s.aideSessionId), [active.id]);
  assert.deepEqual(result.failures, []);
  assert.equal(existsSync(idle.dir), false);
  assert.equal(idleResources.list(type).length, 2);
  assert.equal(activeResources.list(type).length, 2);
  active.releaseLock();
  assert.equal(store.isSessionActive(active.meta), false);
  const reopened = store.openSession(active.id);
  assert.equal(reopened.meta.cwd, join(root, "code-c"));
  await reopened.closeLogs();
});

test("externally assigned Session IDs round-trip safely, preserve metadata and remain cleanable", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-named-session-"));
  const store = new SessionStore(root);
  const id = "lark:app:群 & #1";
  const session = store.createSession({ id, cwd: root });
  t.after(async () => { await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(session.id, id);
  assert.equal(store.openSession(id).id, id);
  assert.equal(store.openSession(id).dir, session.dir);
  assert.equal(store.listSessions()[0]!.aideSessionId, id);
  assert.throws(() => store.createSession({ id, cwd: root }), /already exists/);
  assert.throws(() => store.createSession({ id: "../outside", cwd: root }), /path separators/);
  session.updateMeta({ updatedAt: "2000-01-01T00:00:00.000Z" });
  const clean = store.cleanSessions({ before: new Date("2001-01-01") });
  assert.deepEqual(clean.removed.map((item) => item.aideSessionId), [id]);
  assert.deepEqual(clean.failures, []);
});

test("Failed Session directory removal retains business Resources and the reopenable Session", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-cleanup-failure-"));
  const store = new SessionStore(root);
  const session = store.createSession({ cwd: root });
  t.after(async () => { await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  const resources = new PluginResourceStore({ home: resourceHome(session.dir), pluginInstanceId: "test" });
  const type = { apiVersion: "tests.dev/v1", kind: "Record" };
  resources.storage.register("test", [definition(type)]);
  resources.create({ type, name: "retained", spec: { evidence: "must survive" } });
  session.updateMeta({ updatedAt: "2000-01-01T00:00:00.000Z" });
  const original = fs.rmSync;
  const failure = spyOn(fs, "rmSync").mockImplementation((path, options) => {
    if (path === session.dir) throw new Error("Injected directory removal failure");
    return original(path, options);
  });
  try {
    const result = store.cleanSessions({ before: new Date("2001-01-01") });
    assert.equal(result.removed.length, 0); assert.match(result.failures[0]!.error, /Injected/);
    assert.equal(resources.list(type).length, 1);
    const reopened = store.openSession(session.id); await reopened.closeLogs();
  } finally { failure.mockRestore(); }
  assert.equal(store.cleanSessions({ before: new Date("2001-01-01") }).removed.length, 1);
  assert.equal(resources.list(type).length, 1);
});
