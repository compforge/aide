import jsonPatch from "fast-json-patch";
import { OutputStore } from "../plugins/personal/output/store.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { Requirement, RequirementComment, RequirementPage, RequirementSummary, RequirementListQuery, RequirementCommentQuery } from "@compforge/aide-plugin";
import personalDefinitions from "../plugins/personal/definitions.ts";
import { openPersonCatalog } from "../plugins/personal/person/catalog.ts";
import { LOCAL_ME } from "../plugins/personal/person/model.ts";
import { HarnessFixtures } from "./harness-fixture.ts";
import { InputStore } from "../plugins/personal/input/store.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { personalAdmission } from "../plugins/personal/admission.ts";
import { emptyConnectors } from "../src/connector/client.ts";
import { observeRequirements, SOURCE_TYPE, type RequirementSourceStatus } from "../plugins/personal/source/requirement/observe.ts";
import type { Watch } from "../plugins/personal/source/requirement/config.ts";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const at = (seconds = 0) => new Date(Date.parse("2026-10-22T00:00:00Z") + seconds * 1000).toISOString();
const item = (id = "1"): Requirement => ({ source: "work", category: "story", id, title: "调查", state: "open", assignees: [{ key: "me", name: "本人" }] });
function fixture(t: TestContext, me = true) {
  const root = mkdtempSync(join(tmpdir(), "aide-requirement-"));
  const sessions = new HarnessFixtures(root), session = sessions.create({ id: "source:work", cwd: root });
  const inputs = new InputStore(root);
  let store = new PluginResourceStore({ home: session.home, pluginInstanceId: "personal" });
  store.storage.register("personal", personalDefinitions);
  const marks = { identities: [LOCAL_ME, ...(me ? [{ provider: "tracker", scope: "https://tracker.test/p", id: "me" }] : [])] };
  const catalog = openPersonCatalog(root, marks, pino({ level: "silent" }), () => {});
  const client = () => createResourceClient(store, undefined, undefined, personalAdmission(inputs, new OutputStore(session.home)));
  let resources = client();
  const watch: Watch = { id: "work", source: "work", topicKey: session.id, intervalMs: 300000, repositories: [], userKeys: ["me"], ...(me ? { me: { userKey: "me" } } : {}) };
  store.create({ type: SOURCE_TYPE, name: "watch", spec: watch, status: {} });
  t.after(async () => { await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  let current = item(), list: (q: RequirementListQuery | undefined) => Promise<RequirementPage<RequirementSummary>> = async () => ({ items: [current] });
  let comments: (q: RequirementCommentQuery | undefined) => Promise<RequirementPage<RequirementComment>> = async () => ({ items: [] });
  const connectors = { ...emptyConnectors, requirements: {
    async identity() { return { provider: "tracker", scope: "https://tracker.test/p" }; },
    async list(_source: string, q?: RequirementListQuery) { return list(q); },
    async get(identity: { id: string }) { return { ...current, id: identity.id }; },
    async comments(_identity: unknown, q?: RequirementCommentQuery) { return comments(q); },
  } };
  const resource = () => store.get<Watch, RequirementSourceStatus>(SOURCE_TYPE, "watch");
  return { root, catalog, inputs, connectors, resource, get resources() { return resources; },
    setItem(value: Requirement) { current = value; }, setList(fn: typeof list) { list = fn; }, setComments(fn: typeof comments) { comments = fn; },
    async observe(seconds = 0) { await catalog.persons.initialize(); await observeRequirements({ logger, resources }, resource(), connectors, at(seconds)); },
    async restart() { const reopened = sessions.open(session.id); t.after(() => reopened.closeLogs()); store = new PluginResourceStore({ home: reopened.home, pluginInstanceId: "personal" }); resources = client(); },
  };
}

test("Input plans survive interruption and repeated A-B-A-B changes remain distinct", async (t) => {
  const f = fixture(t); await f.catalog.persons.initialize();
  const failing: typeof f.resources = { ...f.resources, async patch(current, value, options) {
    const patch = (value.type === "json" ? jsonPatch.applyPatch(structuredClone(current), value.value as jsonPatch.Operation[]).newDocument.status : value.value.status) as Record<string, any>;
    if ("pending" in patch && patch.pending === null) throw new Error("Interrupted after Input");
    return f.resources.patch(current, value, options);
  } };
  await assert.rejects(observeRequirements({ logger, resources: failing }, f.resource(), f.connectors, at()), /Interrupted/);
  assert.equal(f.inputs.list().length, 1); assert.ok(f.resource().status.pending);
  await f.restart(); await f.observe();
  assert.equal(f.inputs.list().length, 1); assert.equal(f.resource().status.pending, null);
  for (const [index, state] of ["in_progress", "open", "in_progress"].entries()) {
    f.setItem({ ...item(), state: state as "open" | "in_progress" }); await f.observe(index + 1);
  }
  assert.equal(f.inputs.list().length, 4);
  assert.equal(new Set(f.inputs.list().map((i) => i.metadata.name)).size, 4);
  assert.ok(f.inputs.list().every((i) => !i.spec.sender && i.spec.relation === "observed"));
});

test("Discovery resumes pages and advances its window only after all pages", async (t) => {
  const f = fixture(t); const calls: RequirementListQuery[] = [];
  f.setList(async (q) => { calls.push(q!); return q?.cursor ? { items: [item("2")] } : { items: [item()], nextCursor: "page2" }; });
  await f.observe();
  assert.equal(f.resource().status.scan?.cursor, "page2"); assert.equal(f.resource().status.scannedThrough, null);
  await f.restart(); await f.observe(30);
  assert.equal(calls[1]!.updatedBefore, at()); assert.equal(calls[1]!.cursor, "page2");
  assert.equal(f.resource().status.scannedThrough, at()); assert.equal(f.inputs.list().length, 2);
});

test("Comments are independent of work item timestamps; authors, Me and own Output remain distinct", async (t) => {
  const f = fixture(t); await f.observe();
  const comments: RequirementComment[] = [
    { id: "old", text: "历史", createdAt: at(-10), author: { key: "zhang" } },
    { id: "self", text: "我的话", createdAt: at(2), author: { key: "me" } },
    { id: "at", text: "请看", createdAt: at(3), author: { key: "zhang", name: "张三" }, mentions: [{ key: "me" }] },
    { id: "seen", text: "补充材料", createdAt: at(4), author: { key: "li", name: "李四" } },
    { id: "bot", text: "Aide 已答复", createdAt: at(5), author: { key: "me" }, ownOutput: true },
  ];
  f.setComments(async () => ({ items: comments })); await f.observe(10);
  const inputs = f.inputs.list().filter((i) => i.spec.observation?.kind === "requirement.comment");
  assert.equal(inputs.length, 3); assert.deepEqual(inputs.map((i) => i.spec.relation).sort(), ["observed", "received", "sent"]);
  assert.ok(inputs.every((i) => i.spec.sender && i.spec.source?.kind === "requirement"));
  const people = await f.catalog.persons.list(); assert.ok(people.some((p) => p.spec.name === "张三"));
  await f.restart(); await f.observe(15); assert.equal(f.inputs.list().length, 4);
  f.setComments(async () => { throw new Error("comments unavailable"); });
  const watermark = Object.values(f.resource().status.tracked!)[0]!.commentsThrough;
  await assert.rejects(f.observe(20), /comments unavailable/);
  assert.equal(Object.values(f.resource().status.tracked!)[0]!.commentsThrough, watermark);
});

test("Comments from a delegated account stay unknown without a Me mark", async (t) => {
  const f = fixture(t, false); await f.observe();
  f.setComments(async () => ({ items: [{ id: "c", text: "hello", createdAt: at(5), author: { key: "me" } }] }));
  await f.observe(10); assert.ok(f.inputs.list().every((i) => i.spec.relation === undefined));
});

test("Completed and reassigned tracked items emit a final change even outside discovery scope", async (t) => {
  const f = fixture(t); await f.observe(); f.setList(async () => ({ items: [] }));
  f.setItem({ ...item(), state: "completed", assignees: [{ key: "other" }] });
  f.setComments(async () => ({ items: [{ id: "done", text: "处理完成", createdAt: at(5), author: { key: "other" } }] }));
  await f.observe(10);
  assert.equal(f.inputs.list().length, 3); assert.deepEqual(f.resource().status.tracked, {});
  assert.ok(f.inputs.list().some((i) => i.spec.text.includes("completed")));
});


test("Comment pagination survives restart without advancing the independent watermark", async (t) => {
  const f = fixture(t); await f.observe(); const queries: RequirementCommentQuery[] = [];
  f.setComments(async (q) => {
    queries.push(q!);
    return { items: [{ id: q?.cursor ? "second" : "first", text: "x".repeat(33_000), createdAt: at(2) }], ...(q?.cursor ? {} : { nextCursor: "next" }) };
  });
  await f.observe(10); await f.restart();
  assert.equal(Object.values(f.resource().status.tracked!)[0]!.commentsThrough, at());
  await f.observe(20);
  assert.equal(queries[1]!.end, at(10)); assert.equal(queries[1]!.cursor, "next");
  assert.equal(Object.values(f.resource().status.tracked!)[0]!.commentsThrough, at(10));
  assert.equal(f.inputs.list().length, 3);
  assert.ok(f.inputs.list().every((input) => input.spec.text.length <= 32_000));
});


test("An expired query session replays its frozen discovery window without duplicating Inputs", async (t) => {
  const f = fixture(t); let expired = true;
  f.setList(async (q) => {
    if (q?.cursor && expired) { expired = false; throw new Error("query session expired"); }
    return q?.cursor ? { items: [item("2")] } : { items: [item()], nextCursor: "next" };
  });
  await f.observe(); await f.restart();
  await assert.rejects(f.observe(10), /expired/);
  assert.equal(f.resource().status.scan?.cursor, undefined);
  assert.equal(f.resource().status.scan?.end, at());
  assert.equal(f.resource().status.scannedThrough, null);
  await f.observe(20); await f.observe(30);
  assert.equal(f.inputs.list().length, 2); assert.equal(f.resource().status.scannedThrough, at());
});
