import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { topicCandidates, contextPage, relatedWork } from "../plugins/personal/background.ts";
import { Background as RouteBackground } from "../plugins/personal/route/background.ts";
import { Background as TopicBackground } from "../plugins/personal/topic/background.ts";
import { Background as RoutineBackground } from "../plugins/personal/routine/background.ts";
import { Background as TaskBackground } from "../plugins/personal/task/background.ts";
import { TASK_TYPE, type TaskResource } from "../plugins/personal/task/model.ts";
import type { RoutineResource } from "../plugins/personal/routine/model.ts";
import { ROUTINE_TYPE } from "../plugins/personal/routine/model.ts";
import { topicTools } from "../plugins/personal/topic/tools.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { TOPIC_TYPE, type TopicSpec, type TopicStatus } from "../plugins/personal/topic/model.ts";

/** @case Context is scoped and bounded, survives catalog changes, and ignores irrelevant execution bookkeeping. */
test("resource context pages all live candidates and isolate related Work", async t => {
  const root = mkdtempSync(join(tmpdir(), "aide-context-"));
  const aide = new Aide(root, fakeOptions({ async execute() { throw new Error("No inference expected"); } }, root), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const resources = aide.runtime.plugins.resourceClient("personal");
  const store = aide.personal.store;
  for (let i = 0; i < 25; i++) {
    const c = await aide.topics.ensure(`topic-${i}`);
    await resources.patchStatus(c, { summary: "topic detail ".repeat(1000) });
  }
  const candidates = topicCandidates(store);
  const ids: string[] = [];
  let page = contextPage(candidates);
  while (true) {
    assert.ok(JSON.stringify(page.items).length < 16100);
    assert.ok(page.items.length > 0 && page.items.length <= 20);
    ids.push(...page.items.map(c => c.uid));
    if (page.nextOffset === null) break;
    page = contextPage(candidates, page.nextOffset);
  }
  assert.deepEqual(ids, candidates.map(c => c.uid));
  assert.ok(new RouteBackground(store).text().length < 16500);
  const c = store.resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE).find(c => c.metadata.uid === candidates.at(-1)!.uid)!;
  const captured = new RouteBackground(store);
  const before = captured.text();
  await resources.patchStatus(c, { receipts: [{ key: "execution-bookkeeping", responseId: "response" }] });
  assert.deepEqual(new RouteBackground(store).text(), before);
  await resources.patchStatus(aide.topics.resource(c.spec.id)!, { summary: "changed-beyond-first-page" });
  assert.notDeepEqual(new RouteBackground(store).text(), before, "An off-page change invalidates previously read pages");
  await resources.patchStatus(aide.topics.resource("topic-0")!, { summary: "current-topic-understanding" });
  const deleted = aide.topics.resource("topic-1")!;
  await resources.delete(deleted, deleted.metadata.name);
  assert.ok(!topicCandidates(store).some(c => c.uid === deleted.metadata.uid));

  const definition = { kind: "routine" as const, title: "Related responsibility", instruction: "Inspect assigned evidence", trigger: { cron: null, timezone: "UTC", event: "sample" } };
  const own = await aide.work("topic-0").create(definition);
  const foreign = await aide.work("topic-2").create({ ...definition, title: "foreign-work-marker" });
  assert.deepEqual(relatedWork(store, "topic-0").map(w => w.uid), [own.uid]);
  const work = store.resources.get(ROUTINE_TYPE, own.id) as RoutineResource;
  const context = new RoutineBackground(store, work).text();
  assert.match(context, /Inspect assigned evidence/);
  assert.match(context, /current-topic-understanding/);
  assert.match(context, /Related responsibility/);
  assert.doesNotMatch(context, /foreign-work-marker/);
  const chief = new TopicBackground(store, aide.topics.resource("topic-0"), "topic-0");
  assert.match(chief.text(), /Related responsibility/);
  assert.equal(captured.text(), before, "A captured Background remains stable after resource changes");
  const task = await aide.work("topic-0").create({ kind: "task", title: "Finite goal", instruction: "task-objective-marker", trigger: null });
  const taskBackground = new TaskBackground(store, store.resources.get(TASK_TYPE, task.id) as TaskResource);
  assert.match(taskBackground.text(), /task-objective-marker/);
  assert.doesNotMatch(taskBackground.text(), /foreign-work-marker/);
  await resources.delete(TASK_TYPE, task.id);
  await resources.delete(work, work.metadata.name);
  assert.deepEqual(relatedWork(store, "topic-0"), []);
  assert.equal(relatedWork(store, "topic-2")[0]!.uid, foreign.uid);
});

test("child previews expose omitted Notes and text; paged reads recover the complete context", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-topic-preview-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("No inference expected"); } }, home), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = aide.runtime.plugins.resourceClient("personal");
  const root = await aide.topics.ensure("preview-root");
  const at = new Date().toISOString();
  const notes = ["Older unresolved matter", "A".repeat(500), "B".repeat(501), "C".repeat(9000) + " Not independently verified"].map((text, i) =>
    ({ id: `note-${i}`, createdAt: at, updatedAt: at, text }));
  const child = await resources.create<TopicSpec, TopicStatus>(TOPIC_TYPE, { name: "preview-child",
    spec: { id: "preview-child", parentRef: resourceRef(root) }, status: { summary: "S".repeat(1201), recent: notes, receipts: [] } });
  const short = await resources.create<TopicSpec, TopicStatus>(TOPIC_TYPE, { name: "short-child",
    spec: { id: "short-child", parentRef: resourceRef(root) }, status: { summary: "Complete summary", recent: [notes[0]!], receipts: [] } });
  const tools = topicTools(aide.personal.store, () => root);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await tools.find(tool => tool.name === name)!.execute("preview-test", args, undefined, undefined, {} as never);
    const content = result.content[0]!;
    assert.equal(content.type, "text");
    if (content.type !== "text") throw new Error("Expected text tool output");
    return JSON.parse(content.text);
  };
  const page = await call("list_topics", {});
  const preview = page.items.find((item: { uid: string }) => item.uid === child.metadata.uid);
  assert.equal(preview.noteTotal, 4);
  assert.equal(preview.recent.length, 3);
  assert.equal(preview.summary, "S".repeat(1200) + "… [truncated]");
  assert.deepEqual(preview.recent[0], notes[1], "Exactly fitting text remains complete");
  assert.equal(preview.recent[1].text, "B".repeat(500) + "… [truncated]");
  assert.equal(preview.recent[2].text, "C".repeat(500) + "… [truncated]");
  assert.equal(preview.recent[2].id, notes[3]!.id);
  const complete = page.items.find((item: { uid: string }) => item.uid === short.metadata.uid);
  assert.equal(complete.summary, "Complete summary");
  assert.equal(complete.noteTotal, 1);
  assert.deepEqual(complete.recent, [notes[0]]);
  let offset = 0, text = "", pages = 0;
  while (true) {
    const read = await call("read_topic", { uid: child.metadata.uid, offset });
    assert.equal(read.understandingVersion, preview.version);
    text += read.text;
    pages++;
    if (read.nextOffset === null) break;
    assert.ok(read.nextOffset > offset);
    offset = read.nextOffset;
  }
  assert.ok(pages > 1, "Full understanding exceeds a single read page");
  assert.deepEqual(JSON.parse(text), { ...child.spec, persons: preview.persons, conditions: child.status.conditions, summary: child.status.summary, recent: notes });
});
