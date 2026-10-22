import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HarnessFixtures } from "./harness-fixture.ts";
import { preparePluginDataDirectories } from "../src/host/plugin/data.ts";

test("Harness storage reopens independent resource contexts without creating a main context", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-contexts-"));
  const store = new HarnessFixtures(root);
  const first = store.create({ cwd: join(root, "code-a") });
  const second = store.create({ cwd: join(root, "code-b") });
  assert.deepEqual(first.meta.contexts, {});
  first.setHarnessTarget("coding", { harnessTargetId: "coding", harness: "codex" });
  for (const contextId of ["resource-one", "resource-two"]) {
    first.setExecutionContext(contextId, { contextId, historyAfterSeq: 7, harnessSessions: {} });
    first.setContextHarnessSession(contextId, "coding", { harness: "codex", harnessSessionId: contextId,
      resumeState: { version: 1, data: { id: contextId } }, contextAfterSeq: 9 });
  }
  const event = first.appendEvent({ kind: "user_message", source: { type: "user" }, contextId: "resource-two", invocationId: "invocation-two",
    payload: { messageId: "message-two", content: [{ type: "text", text: "保留执行历史" }] } });
  const reopened = new HarnessFixtures(root).open(first.id);
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
  const data = preparePluginDataDirectories(root, { pluginId: "tests/plugin", pluginInstanceId: "default" });
  assert.equal(data.global, join(root, "plugins", "tests%2Fplugin"));
  assert.equal(data.instance, join(data.global, "instances", "default"));
  assert.equal("session" in data, false);
  assert.equal(existsSync(join(root, "projects")), false);
});
