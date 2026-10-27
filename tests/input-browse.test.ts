import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { httpChannel } from "../src/api/index.ts";
import { inputList, inputFilters, inputDetail } from "../src/api/inputs.ts";
import { browseInputs, inputFacets } from "../plugins/personal/input/browse.ts";
import { INPUT_TYPE, type InputStatus, type InputSpec } from "../plugins/personal/input/model.ts";
import { InputDefinition } from "../plugins/personal/input/definition.ts";
import { TOPIC_TYPE } from "../plugins/personal/topic/model.ts";
import { TASK_TYPE } from "../plugins/personal/task/model.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { webAddress } from "../src/channel/address.ts";
import { requirementAddress } from "../connectors/requirements/address.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import type { InputDetailView, InputListView, InputFiltersView } from "../src/api/types.ts";

const log = pino({ level: "silent" });
function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-input-browse-"));
  const aide = new Aide(home, fakeOptions({ async chief() { return "ok"; }, async execute() { throw new Error("No Work expected"); } }, home), log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, aide, store: aide.topics.inputStore };
}
const finished = (): InputStatus => ({ route: { completedAt: new Date().toISOString(), result: { topics: [], reason: "Quiet observation" } } });
const observation = (n: number): InputSpec => ({ origin: "source", originId: "personal.requirements", text: `需求 ${n} needle 中文 %_`,
  source: requirementAddress({ source: "work", category: "story", id: String(n) }, "project"),
  originRef: { apiVersion: "aide.dev/v1alpha1", kind: "RequirementSource", namespace: "v1", name: n % 2 ? "watch-a" : "watch-b", uid: n % 2 ? "source-a" : "source-b" } });

test("Input browsing filters before paging, orders ties deterministically and keeps global facets", t => {
  const { aide, store } = setup(t);
  const originals = Array.from({ length: 47 }, (_, i) => store.submit("test", `input-${String(i).padStart(2, "0")}`, i % 3 ? observation(i) : { origin: "channel", originId: "web", text: `web ${i}` }, finished()));
  const expected = [...originals].sort((a, b) => b.metadata.creationTimestamp.localeCompare(a.metadata.creationTimestamp) || (store.key(a.metadata.name) < store.key(b.metadata.name) ? 1 : -1));
  const pages = [1, 2, 3].map(page => browseInputs(store, { page }));
  assert.deepEqual(pages.map(p => p.items.length), [20, 20, 7]);
  assert.deepEqual(pages.flatMap(p => p.items.map(i => i.input.metadata.name)), expected.map(i => i.metadata.name));
  const query = { connector: "requirements:work", sourceUid: "source-a", q: "NEEDLE", pageSize: 3 };
  const filtered = browseInputs(store, query);
  const matching = expected.filter(p => p.spec.originRef?.uid === "source-a");
  assert.equal(filtered.total, matching.length);
  assert.deepEqual(filtered.items.map(i => i.input.metadata.name), matching.slice(0, 3).map(i => i.metadata.name));
  assert.equal(browseInputs(store, { q: "%_" }).total, 31, "Search treats wildcard characters literally");
  assert.equal(browseInputs(store, { q: "' OR 1=1 --" }).total, 0);
  assert.equal(browseInputs(store, { origin: "channel", originId: "web" }).total, 16);
  assert.equal(browseInputs(store, { connector: "" }).total, 16);
  assert.equal(browseInputs(store, { page: 999 }).page, 3);
  assert.equal(browseInputs(store, { q: "absent", page: 99 }).page, 1);
  const result = inputList(aide, { q: "absent" });
  assert.equal(result.items.length, 0);
  assert.ok(inputFilters(aide).connectors.some(c => c.value === "requirements:work"));
  assert.equal(inputFilters(aide).sources.length, 2);
  assert.equal("observation" in inputList(aide, {}).items[0]!, false, "List returns a preview rather than source evidence");
});

test("Completion requires every consumer receipt; exceptions remain searchable without claiming current failure", t => {
  const { store } = setup(t);
  const at = new Date().toISOString(), ref = { ...TOPIC_TYPE, namespace: "v1" as const, name: "gone", uid: "gone-uid" };
  store.submit("test", "unrouted", { origin: "channel", originId: "web", text: "pending" });
  store.submit("test", "pending-work", observation(1), { ...finished(), assess: { a: { resource: ref, assignedAt: at, completedAt: at } },
    handle: { w: { resource: { ...ref, kind: "Task" }, assignedAt: at, request: { action: "context" } } } });
  store.submit("test", "cancelled", observation(2), { ...finished(), assess: { a: { resource: ref, assignedAt: at, completedAt: at, result: { summary: "Deleted", disposition: "cancelled" } } } });
  store.submit("test", "recovered", observation(3), { route: { ...finished().route, lastError: "Previous error" } });
  assert.deepEqual(new Set(browseInputs(store, { state: "pending" }).items.map(i => i.input.metadata.name)), new Set(["unrouted", "pending-work"]));
  assert.equal(browseInputs(store, { state: "completed" }).total, 2);
  const recovered = browseInputs(store, { errors: true });
  assert.equal(recovered.items[0]!.input.metadata.name, "recovered");
  assert.equal(recovered.items[0]!.state, "completed");
});

test("Browsing is scoped, does not refresh eviction access times and recognizes Lark and environment connectors", t => {
  const { store, home } = setup(t);
  store.submit("test", "lark", { origin: "source", originId: "personal.lark", text: "message" }, finished());
  store.submit("test", "env", { origin: "source", originId: "personal.environments", text: "workload", observation: { environment: "qa" } }, finished());
  store.storage.register("foreign", [InputDefinition]);
  new PluginResourceStore({ home, pluginInstanceId: "foreign" }).create({ type: INPUT_TYPE, name: "foreign", spec: observation(1), status: finished() });
  store.resources.create({ type: INPUT_TYPE, name: "nested", namespace: "v1/project/other", spec: observation(2), status: finished() });
  const accessed = () => store.storage.db.prepare("SELECT key, accessed FROM resources ORDER BY key").all();
  const before = accessed();
  assert.equal(browseInputs(store).total, 2);
  assert.deepEqual(new Set(inputFacets(store).map(f => f.connector)), new Set(["lark", "environments:qa"]));
  assert.deepEqual(accessed(), before);
});

test("Planned retries are not historical events, and completed routing never appears to await an old retry", t => {
  const { aide, store } = setup(t);
  const retryAt = new Date(Date.now() + 60_000).toISOString();
  store.submit("test", "retrying", observation(1), { route: { attempts: 2, nextAttemptAt: retryAt, lastError: "classification failed" } });
  const retry = inputDetail(aide, "retrying")!;
  const planned = retry.timeline.find(e => e.status === "retrying")!;
  assert.equal(planned.at, undefined);
  assert.ok(planned.text!.includes(retryAt));
  assert.equal(retry.routeAttempts, 2);
  store.submit("test", "recovered-route", observation(2), { route: { ...finished().route, nextAttemptAt: retryAt, lastError: "previous failure" } });
  const recovered = inputDetail(aide, "recovered-route")!;
  assert.equal(recovered.timeline.some(e => e.status === "retrying"), false);
  assert.equal(recovered.timeline.find(e => e.title === "路由异常记录")!.status, "recorded");
});

test("Timeline retains independent consumers, resolves exact UIDs and includes only explicit Output associations", async t => {
  const { aide, store } = setup(t);
  const a = await aide.topics.ensure("a", webAddress("a"), "会话 A"), b = await aide.topics.ensure("b", webAddress("b"), "旧会话 B");
  const work = await aide.work("a").create({ kind: "task", title: "核对进展", instruction: "check", trigger: null });
  const task = aide.topics.resources.get(TASK_TYPE, work.id);
  let input = store.submit("test", "shared & #1", observation(1));
  const at = (n: number) => new Date(Date.parse(input.metadata.creationTimestamp) + n * 1000).toISOString();
  input = store.update(input, { route: { startedAt: at(1), completedAt: at(2), attempts: 2, result: { topics: [resourceRef(a), resourceRef(b)], reason: "两个话题都相关" } },
    assess: { [a.metadata.uid]: { resource: resourceRef(a), assignedAt: at(2), completedAt: at(4), result: { summary: "交给 Task" } },
      [b.metadata.uid]: { resource: resourceRef(b), assignedAt: at(2), completedAt: at(5), result: { summary: "目标已删除", disposition: "cancelled" } } },
    handle: { [task.metadata.uid]: { resource: resourceRef(task), assignedAt: at(4), appliedAt: at(5), startedAt: at(6), executionId: "task-run", request: { action: "context", note: "核对" }, lastError: "需要核对既有副作用" } } });
  aide.topics.resources.requestDeletion(TOPIC_TYPE, b.metadata.name);
  aide.topics.resources.finalizeDeletion(TOPIC_TYPE, b.metadata.name);
  const replacement = await aide.topics.ensure("b", webAddress("b"), "新会话 B");
  assert.notEqual(replacement.metadata.uid, b.metadata.uid);
  const base = { target: webAddress("a"), topicId: "a", topic: { ...resourceRef(a), uid: a.metadata.uid }, executionId: "chief-run" };
  aide.outputStore.create("a", "related", { ...base, text: "显式关联的回复", inputIds: [input.metadata.name, "other"] });
  aide.outputStore.create("a", "unrelated", { ...base, text: "同一 execution 的其他回复", inputIds: ["other"] });
  const detail = inputDetail(aide, input.metadata.name)!;
  assert.equal(detail.outputCount, 1);
  assert.equal(detail.routeAttempts, 2);
  assert.ok(detail.timeline.some(e => e.title === "Work 已应用请求"));
  assert.ok(detail.timeline.some(e => e.stage === "handle" && e.title.includes("尚未确认完成")));
  assert.ok(detail.timeline.some(e => e.stage === "assess" && e.status === "cancelled"));
  assert.equal(detail.timeline.find(e => e.consumer?.ref.uid === b.metadata.uid)!.consumer!.available, false);
  assert.equal(detail.timeline.find(e => e.consumer?.ref.uid === a.metadata.uid)!.consumer!.topicId, "a");
  assert.equal(detail.timeline.find(e => e.title === "Work 办理异常记录")!.at, undefined);
  assert.equal(detail.timeline.some(e => e.text?.includes("同一 execution 的其他回复")), false);
  assert.equal(detail.timeline.some(e => e.stage === "handle" && e.status === "completed"), false, "A reply is not a Work handling receipt");
  const dated = detail.timeline.flatMap(e => e.at ? [e.at] : []);
  assert.deepEqual(dated, [...dated].sort());
  assert.deepEqual(store.get(input.metadata.name), input, "Inspection never changes processing receipts");
  assert.equal(inputDetail(aide, input.metadata.name, "wrong-uid"), undefined);
  assert.equal(inputDetail(aide, "missing"), undefined);
});

test("Inputs HTTP routes validate filters and paginate all retained inputs, including quiet unassigned facts", async t => {
  const { aide, store, home } = setup(t);
  for (let i = 0; i < 27; i++) store.submit("test", `fact-${i}`, observation(i), finished());
  const server = httpChannel(aide, log); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const first = await (await fetch(url + "/inputs/list?pageSize=10")).json() as InputListView;
  const second = await (await fetch(url + "/inputs/list?pageSize=10&page=2")).json() as InputListView;
  assert.equal(first.total, 27); assert.equal(first.items.length, 10); assert.equal(first.pages, 3);
  assert.equal("filters" in first, false, "Page polling never recomputes global facets");
  const filters = await (await fetch(url + "/inputs/filters")).json() as InputFiltersView;
  assert.ok(filters.connectors.some(c => c.value === "requirements:work"));
  assert.equal(new Set([...first.items, ...second.items].map(i => i.uid)).size, 20);
  const filtered = await (await fetch(url + "/inputs/list?connector=requirements%3Awork&sourceUid=source-a")).json() as InputListView;
  assert.equal(filtered.total, 13);
  const item = first.items[0]!;
  const detail = await (await fetch(url + "/inputs/detail?" + new URLSearchParams({ id: item.id, uid: item.uid }))).json() as InputDetailView;
  assert.ok(detail.timeline.some(e => e.title === "接收 Input"));
  assert.equal(detail.outputCount, 0);
  for (const query of ['page=-1', 'pageSize=101', 'errors=maybe', 'state=failed', 'extra=true']) assert.equal((await fetch(url + '/inputs/list?' + query)).status, 400);
  assert.equal((await fetch(url + '/inputs/detail?id=missing')).status, 404);
  assert.equal((await fetch(url + '/inputs/detail?uid=missing')).status, 400);
  for (const path of ['/', '/people', '/inputs']) {
    const response = await fetch(url + path); assert.equal(response.status, 200);
    const html = await response.text(); assert.match(html, /href="\/inputs"/); assert.match(html, /Persons/); assert.match(html, /Topics/);
  }
  for (const path of ['/inputs.js', '/inputs.css']) assert.equal((await fetch(url + path)).status, 200);
  await aide.close();
  const reopened = new Aide(home, fakeOptions({ async execute() { throw new Error("No Work expected"); } }, home), log);
  assert.equal(inputList(reopened, {}).total, 27);
  assert.deepEqual(inputDetail(reopened, item.id)!.input.status, detail.input.status);
  await reopened.close();
});

/** @case Observation endpoints only read Sessions attached to the exact Input UID. */
test("Input observation HTTP exports JSON and escaped HTML with exact reference guards", async t => {
  const { aide, store } = setup(t);
  let reads = 0;
  aide.readSession = async agent => { reads++; return { schema_version: "agent-ledger/session@1", session: { source: "pi", id: agent.sessionId }, nodes: [] }; };
  const input = store.submit("test", "observe", { origin: "source", originId: "test", text: "<script>alert(1)</script>" },
    { route: { completedAt: new Date().toISOString(), agent: { harness: "route", sessionId: "native" }, result: { topics: [], reason: "rule" } } });
  store.update(input, { route: { ...input.status.route!, completedAt: new Date().toISOString() } });
  const server = httpChannel(aide, log); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const query = new URLSearchParams({ id: input.metadata.name, uid: input.metadata.uid });
  const job = await fetch(`${base}/inputs/job?${query}&download=1`);
  assert.equal(job.status, 200); assert.match(job.headers.get("content-disposition")!, /job.json/);
  assert.equal((await job.json() as { job: { id: string } }).job.id, input.metadata.uid);
  const html = await (await fetch(`${base}/inputs/job?${query}&format=html`)).text();
  assert.ok(!html.includes("<script>alert(1)</script>")); assert.ok(html.includes("&lt;script&gt;"));
  const count = reads;
  assert.equal((await fetch(`${base}/inputs/session?${query}&harness=route&sessionId=unrelated`)).status, 404);
  assert.equal((await fetch(`${base}/inputs/session?${query}&harness=chief&sessionId=native`)).status, 404);
  assert.equal((await fetch(`${base}/inputs/job?id=observe&uid=wrong`)).status, 404);
  assert.equal((await fetch(`${base}/inputs/session?${query}&file=/etc/passwd`)).status, 400);
  assert.equal(reads, count);
  const session = await fetch(`${base}/inputs/session?${query}&harness=route&sessionId=native`);
  assert.equal(session.status, 200); assert.equal(reads, count + 1);
  assert.equal((await session.json() as { schema_version: string }).schema_version, "agent-ledger/session@1");
});

/** @case Missing optional observation capability is unavailable, not an internal server error. */
test("Observation reader absence returns unavailable while Job export retains business facts", async t => {
  const { aide, store } = setup(t);
  assert.equal(aide.readSession, undefined);
  const input = store.submit("test", "optional-reader", observation(0), {
    route: { ...finished().route, agent: { harness: "route", sessionId: "native" } },
  });
  const server = httpChannel(aide, log); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const query = new URLSearchParams({ id: input.metadata.name, uid: input.metadata.uid });
  const session = await fetch(`${base}/inputs/session?${query}&harness=route&sessionId=native`);
  assert.equal(session.status, 404);
  const response = await fetch(`${base}/inputs/job?${query}`);
  assert.equal(response.status, 200);
  const job = await response.json() as { nodes: { id: string }[]; issues: string[] };
  assert.ok(job.nodes.some(n => n.id === "route"));
  assert.match(job.issues.join("\n"), /Session reader unavailable/);
  aide.readSession = async () => { throw new Error("Native file read failure"); };
  assert.equal((await fetch(`${base}/inputs/session?${query}&harness=route&sessionId=native`)).status, 500);
});
