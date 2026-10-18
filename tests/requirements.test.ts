import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Connectors } from "../connectors/index.ts";
import { loadWatches, type Watch } from "../plugins/personal/source-config.ts";
import { MeegleCliRequirementConnector } from "../connectors/requirements/meego.ts";
import { SessionStore } from "../src/runtime/store/store.ts";
import { PluginResourceStore } from "../src/runtime/plugin/resource.ts";
import { createResourceClient } from "../src/runtime/plugin/resource-client.ts";
import { observeRequirements, SOURCE_TYPE } from "../plugins/personal/source.ts";
import { CHIEF_TYPE } from "../plugins/personal/chief-model.ts";

test("Meego selects assigned user keys, not participants or display names, and preserves unfinished states", async () => {
  const captured: string[][] = [];
  const connector = new MeegleCliRequirementConnector({ source: "work", provider: "meego", projectKey: "p", categories: ["story"], userKeys: ["me"], assigneeField: "owner" }, async (args) => {
    captured.push([...args]);
    return { data: [
      { work_item_id: 1, name: "mine", owner: [{ user_key: "me", name: "My name" }], work_item_status: "未完成" },
      { work_item_id: 2, name: "participated", owner: [{ user_key: "someone" }], all_participate_persons: ["me"] },
      { work_item_id: 3, name: "name only", owner: [{ name: "me" }] },
      { work_item_id: 4, name: "finished", owner: ["me"], work_item_status: "已完成" },
    ] };
  });
  const rows = await connector.list();
  assert.deepEqual(rows.map((row) => row.id), ["1", "4"]);
  assert.notEqual(rows[0]!.state, "completed"); assert.equal(rows[1]!.state, "completed");
  assert.match(captured[0]!.join(" "), /`owner`/);
  assert.doesNotMatch(captured[0]!.join(" "), /all_participate_persons/);
  await assert.rejects(connector.get({ source: "other", category: "story", id: "1" }), /belongs to/);
  const missing = new MeegleCliRequirementConnector(connector.config, async () => [{ work_item_id: 1, name: "Missing owner" }]);
  await assert.rejects(missing.list(), /assignee field owner/);
});

test("Requirement Source commits the inbox before its watermark and never creates Work; restart/redelivery is idempotent", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = new SessionStore(root); const session = sessions.createSession({ cwd: root });
  const store = new PluginResourceStore({ session, pluginInstanceId: "personal" });
  const resources = createResourceClient(store);
  const watch: Watch = { id: "mine", source: "work", conversationId: "me", intervalMs: 300_000, repositories: [] };
  const resource = store.create({ type: SOURCE_TYPE, name: "mine", spec: watch, status: {} });
  let updatedAt = "1";
  let fail = false;
  const connectors = new Connectors([{ source: "work", provider: "fixture", async list() {
    if (fail) throw new Error("Unavailable");
    return [{ source: "work", category: "story", id: "1", title: "Build", state: "open", updatedAt }];
  }, async get() { throw new Error("Source should fetch summaries only"); } }], []);
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  await assert.rejects(observeRequirements({ logger, resources: { ...resources, async patchStatus() { throw new Error("Interrupted after emission"); } } }, resource, connectors), /Interrupted/);
  assert.equal(store.list(CHIEF_TYPE).length, 1);
  assert.deepEqual(store.get(SOURCE_TYPE, "mine").status, {});
  await observeRequirements({ logger, resources }, resource, connectors);
  assert.equal(store.list(CHIEF_TYPE).length, 1);
  // Reopen persisted state, as a restarted worker would.
  const reopened = new PluginResourceStore({ session: sessions.openSession(session.id), pluginInstanceId: "personal" });
  const context = { logger, resources: createResourceClient(reopened) };
  await observeRequirements(context, reopened.get(SOURCE_TYPE, "mine"), connectors);
  assert.equal(reopened.list(CHIEF_TYPE).length, 1);
  updatedAt = "2";
  await observeRequirements(context, reopened.get(SOURCE_TYPE, "mine"), connectors);
  assert.equal(reopened.list(CHIEF_TYPE).length, 2);
  const before = reopened.get(SOURCE_TYPE, "mine").status;
  fail = true;
  await assert.rejects(observeRequirements(context, reopened.get(SOURCE_TYPE, "mine"), connectors), /Unavailable/);
  assert.deepEqual(reopened.get(SOURCE_TYPE, "mine").status, before);
});

test("Discovery requires an explicit assignee scope and unique watch identity", (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-connectors-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "connectors.json");
  const watch = { id: "mine", source: "work", conversationId: "me" };
  const config = { requirements: { work: { provider: "meego", projectKey: "project", userKeys: [] as string[] } }, watches: [watch] };
  writeFileSync(path, JSON.stringify(config)); assert.throws(() => loadWatches(path), /non-empty/);
  config.requirements.work.userKeys = ["me"]; writeFileSync(path, JSON.stringify(config));
  assert.equal(loadWatches(path)[0]!.intervalMs, 300_000);
  config.watches.push(watch); writeFileSync(path, JSON.stringify(config)); assert.throws(() => loadWatches(path), /Duplicate/);
});
