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
