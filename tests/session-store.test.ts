import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionStore } from "../src/host/store/store.ts";
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
  assert.throws(() => store.openSession("../outside"), /invalid aide session id/);

  const instance = { pluginId: "tests/plugin", pluginInstanceId: "default" };
  const data = (session: typeof first) => preparePluginDataDirectories({ aideSessionId: session.id, dir: session.dir }, instance);
  const firstData = data(first);
  const secondData = data(second);
  assert.equal(firstData.global, join(root, "plugins", "tests%2Fplugin"));
  assert.equal(firstData.global, secondData.global);
  assert.notEqual(firstData.session, secondData.session);
  assert.equal(firstData.instance, join(firstData.session, "default"));
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
  active.updateMeta({ cwd: join(root, "code-c"), updatedAt: "2000-01-01T00:00:00.000Z" });
  idle.updateMeta({ updatedAt: "2000-01-01T00:00:00.000Z" });
  assert.equal(active.acquireLock(), true);
  assert.equal(store.isSessionActive(active.meta), true);
  const result = store.cleanSessions({ before: new Date("2001-01-01T00:00:00.000Z") });
  assert.deepEqual(result.removed.map((s) => s.aideSessionId), [idle.id]);
  assert.deepEqual(result.skippedActive.map((s) => s.aideSessionId), [active.id]);
  assert.deepEqual(result.failures, []);
  assert.equal(existsSync(idle.dir), false);
  active.releaseLock();
  assert.equal(store.isSessionActive(active.meta), false);
  const reopened = store.openSession(active.id);
  assert.equal(reopened.meta.cwd, join(root, "code-c"));
  await reopened.closeLogs();
});
