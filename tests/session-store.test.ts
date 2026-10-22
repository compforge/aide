import { resourceHome } from "../src/host/resource/storage.ts";
import { definition } from "./fixtures/resource-definition.ts";
import { spyOn } from "bun:test";
import * as fs from "node:fs";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionStore } from "../src/host/store/store.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { preparePluginDataDirectories } from "../src/host/plugin/data.ts";

test("Sessions from different execution directories share one home and reopen or fork by id", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-sessions-"));
  const store = new SessionStore(root);
  const first = store.createSession({ cwd: join(root, "code-a") });
  const second = store.createSession({ cwd: join(root, "code-b") });
  first.setHarnessTarget("coding", { harnessTargetId: "coding", harness: "codex" });
  first.ensureHarnessInvocationLane("side", "invocation-side", "main");
  const mainBinding = { harness: "codex", harnessSessionId: "native-main", resumeState: { version: 1, data: { id: "native-main" } } };
  const sideBinding = { harness: "codex", harnessSessionId: "native-side", resumeState: { version: 1, data: { id: "native-side" } } };
  first.setLaneHarnessSession("main", "coding", mainBinding);
  first.setLaneHarnessSession("side", "coding", sideBinding);
  const event = first.appendEvent({ kind: "user_message", source: { type: "user" }, laneId: "side", turnId: "turn-side",
    payload: { messageId: "message-side", content: [{ type: "text", text: "保留执行历史" }] } });
  const fork = store.forkSession(first.id, { cwd: join(root, "code-c") });
  const reopened = new SessionStore(root).openSession(first.id);
  t.after(async () => {
    for (const session of [first, second, fork, reopened]) await session.closeLogs();
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(first.dir, join(root, "sessions", first.id));
  assert.equal(second.dir, join(root, "sessions", second.id));
  assert.equal(fork.dir, join(root, "sessions", fork.id));
  assert.equal(fork.meta.forkedFrom?.aideSessionId, first.id);
  assert.equal(fork.meta.cwd, join(root, "code-c"));
  assert.equal(reopened.dir, first.dir);
  assert.deepEqual(reopened.meta.lanes.main!.harnessSessions.coding, mainBinding);
  assert.deepEqual(reopened.meta.lanes.side!.harnessSessions.coding, sideBinding);
  assert.equal(reopened.ledger.read()[0]!.eventId, event.eventId);
  assert.equal(reopened.projection.messages.get("message-side")?.kind, "input");
  assert.deepEqual(reopened.projection.messages.get("message-side"), first.projection.messages.get("message-side"));
  assert.deepEqual(fork.meta.lanes.main!.harnessSessions, {});
  assert.deepEqual(fork.meta.lanes.side!.harnessSessions, {});
  assert.equal(fork.meta.lanes.side!.createdFor.type, "harness_invocation");
  assert.notEqual(fork.ledger.read()[0]!.eventId, event.eventId);
  assert.deepEqual(fork.ledger.read()[0]!.scope, { type: "session", aideSessionId: fork.id });
  assert.deepEqual(fork.projection.messages.get("message-side"), first.projection.messages.get("message-side"));
  assert.deepEqual(new Set(store.listSessions().map((s) => s.aideSessionId)), new Set([first.id, second.id, fork.id]));
  assert.deepEqual(readdirSync(root), ["sessions"]);
  assert.throws(() => store.openSession("../outside"), /path separators/);

  const instance = { pluginId: "tests/plugin", pluginInstanceId: "default" };
  const data = (session: typeof first) => preparePluginDataDirectories(root, instance);
  const firstData = data(first);
  const secondData = data(second);
  assert.equal(firstData.global, join(root, "plugins", "tests%2Fplugin"));
  assert.equal(firstData.global, secondData.global);
  assert.equal(firstData.instance, secondData.instance);
  assert.equal(firstData.instance, join(firstData.global, "instances", "default"));
  assert.equal("project" in firstData, false);
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
