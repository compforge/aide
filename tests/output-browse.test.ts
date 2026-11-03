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
import { browseOutputs, outputFacets } from "../plugins/personal/output/browse.ts";
import { outputList, outputDetail, outputFilters, outputSession } from "../src/api/outputs.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { TOPIC_TYPE } from "../plugins/personal/topic/model.ts";
import { personRefs, PERSON_TYPE } from "../plugins/personal/person/model.ts";
import { webAddress } from "../src/channel/address.ts";
import { addressFor } from "./address-fixture.ts";
import type { OutputListView } from "../src/api/types.ts";

const log = pino({ level: "silent" });
async function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-output-browse-"));
  const aide = new Aide(home, fakeOptions({ async chief() { return "ok"; }, async execute() { throw new Error("No Work expected"); } }, home), log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const topic = await aide.topics.ensure("a", webAddress("a"), "主题 A");
  const store = aide.topics.outputStore;
  const spec = { topic: { ...resourceRef(topic), uid: topic.metadata.uid }, topicId: "a", target: webAddress("a") };
  const create = (id: string, text = `正文 ${id} needle 中文 %_`) => store.create("test", id, { ...spec, text });
  return { home, aide, topic, store, spec, create };
}

test("Outputs filter before stable pagination and browsing never refreshes retention", async t => {
  const { aide, store, create, topic } = await setup(t);
  const outputs = Array.from({ length: 43 }, (_, i) => create(`out-${String(i).padStart(2, '0')}`));
  store.update('out-02', s => ({ ...s, phase: 'failed', lastError: 'provider unavailable' }));
  store.update('out-03', s => ({ ...s, phase: 'uncertain' }));
  store.update('out-04', s => ({ ...s, phase: 'cancelled' }));
  const accessed = () => store.storage.db.prepare('SELECT key, accessed FROM resources ORDER BY key').all();
  const before = accessed();
  const pages = [1, 2, 3].map(page => outputList(aide, { page }));
  assert.deepEqual(pages.map(p => p.items.length), [20, 20, 3]);
  assert.deepEqual(pages.flatMap(p => p.items.map(i => i.id)), [...outputs].reverse().map(o => o.metadata.name));
  assert.equal(browseOutputs(store, { phase: 'failed', pageSize: 1 }).items[0]!.metadata.name, 'out-02');
  assert.equal(browseOutputs(store, { phase: 'uncertain' }).total, 1);
  assert.equal(browseOutputs(store, { phase: 'cancelled' }).total, 1);
  assert.equal(browseOutputs(store, { disclosure: 'pending', q: 'NEEDLE', topicUid: topic.metadata.uid }).total, 43);
  assert.equal(browseOutputs(store, { q: '%_' }).total, 43);
  assert.equal(browseOutputs(store, { q: "' OR 1=1 --" }).total, 0);
  assert.equal(browseOutputs(store, { from: outputs[10]!.metadata.creationTimestamp, to: outputs[12]!.metadata.creationTimestamp }).total, 3);
  assert.equal(browseOutputs(store, { page: 100 }).page, 3);
  assert.equal(browseOutputs(store, { q: 'missing', page: 100 }).page, 1);
  assert.equal(outputFilters(aide).topics[0]!.label, '主题 A');
  assert.equal('text' in pages[0]!.items[0]!, false);
  assert.deepEqual(accessed(), before);
});

test("Disclosure denial and successful fallback delivery remain separate and both audiences are searchable", async t => {
  const { aide, store, home, spec } = await setup(t);
  const person = (name: string) => ({ ...PERSON_TYPE, namespace: 'v1' as const, name, uid: `person-${name}` });
  const output = store.create('test', 'redirected', { ...spec, text: '原始私密内容', receivers: personRefs([person('other')]) });
  const actualAddress = addressFor(home, webAddress('me'));
  store.update('redirected', s => ({ ...s, phase: 'delivered', attempts: 1, deliveredAt: new Date().toISOString(),
    disclosure: { decision: 'denied', reason: '接收人不可见', checkedAt: new Date().toISOString(), fingerprint: 'test' },
    delivery: { address: actualAddress, target: webAddress('me'), stream: store.replacement(output, 'test', '已阻止外发'), receivers: personRefs([person('me')]) },
    receipt: { id: 'message', scope: 'web' } }));
  for (const receiverUid of ['person-other', 'person-me']) assert.equal(browseOutputs(store, { receiverUid }).total, 1);
  for (const addressUid of [output.spec.target.uid, actualAddress.uid]) assert.equal(browseOutputs(store, { addressUid }).total, 1);
  assert.equal(browseOutputs(store, { phase: 'delivered', disclosure: 'denied', q: '已阻止' }).total, 1);
  assert.equal(outputFacets(store).receivers.length, 2);
  assert.equal(outputFacets(store).addresses.length, 2);
  const detail = outputDetail(aide, 'redirected')!;
  assert.equal(detail.text, '原始私密内容'); assert.equal(detail.delivery!.text, '已阻止外发');
  assert.equal(detail.disclosure, 'denied'); assert.equal(detail.phase, 'delivered');
  assert.equal(detail.actualAddress!.href, '/addresses?' + new URLSearchParams({ name: actualAddress.name, uid: actualAddress.uid }));
  assert.equal(detail.delivery!.receivers[0]!.ref.uid, 'person-me');
  assert.equal(JSON.parse(JSON.stringify(detail)).delivery.receivers.length, 1);
});

test("Waiting projections retain reasons; deleted and replaced identities never receive historical links", async t => {
  const { aide, store, spec, topic } = await setup(t);
  const input = aide.topics.inputStore.submit('test', 'input', { origin: 'source', originId: 'test', text: 'material' });
  const output = store.create('test', 'waiting', { ...spec, text: '等待', inputIds: ['input', 'legacy'], inputUids: { input: input.metadata.uid } });
  for (const reason of ['frequency', 'receiver-busy', 'provider'] as const) {
    store.update('waiting', s => ({ ...s, deliveryWait: { reason, until: '2030-01-01T00:00:00.000Z' } }));
    assert.equal(outputDetail(aide, 'waiting')!.wait!.reason, reason);
  }
  const detail = outputDetail(aide, 'waiting')!;
  assert.equal(detail.inputs[0]!.available, true); assert.equal(detail.inputs[1]!.href, undefined);
  // Change only the retained Output reference to an old incarnation, as a persisted historical fixture.
  const historic = { ...output, spec: { ...output.spec, topic: { ...spec.topic, uid: 'old-topic-uid' }, inputUids: { input: 'old-input-uid' } } };
  store.storage.db.prepare("UPDATE resources SET data = json_set(data, '$.object', json(?)) WHERE key = ?").run(JSON.stringify(historic), store.key('waiting'));
  const old = outputDetail(aide, 'waiting')!;
  assert.equal(old.topic.available, false); assert.equal(old.topic.href, undefined); assert.equal(old.inputs[0]!.href, undefined);
  assert.ok(aide.topics.resources.get(TOPIC_TYPE, topic.metadata.name));
  assert.equal(outputDetail(aide, 'waiting', 'wrong-uid'), undefined);
  assert.equal(outputDetail(aide, 'missing'), undefined);
  store.update('waiting', s => ({ ...s, phase: 'failed', deliveryWait: { reason: 'provider', until: '2030-01-01T00:00:00.000Z' } }));
  assert.equal(outputDetail(aide, 'waiting')!.wait, undefined, 'An obsolete wait is not displayed after a terminal result');
});

test("Outputs HTTP validates requests, links only the recorded native Session and serves the new navigation", async t => {
  const { aide, store, spec, create } = await setup(t);
  const output = store.create('test', 'session-output', { ...spec, text: '<script>unsafe</script>',
    executionId: 'execution', createdBy: { agent: { harness: 'chief', sessionId: 'native' }, executionId: 'execution', toolCallId: 'say-call' } });
  create('no-session');
  let reads = 0;
  aide.readSession = async agent => { reads++; assert.equal(agent.sessionId, 'native'); return { schema_version: 'agent-ledger/session@1', session: { source: 'pi', id: agent.sessionId }, nodes: [] }; };
  // Keep fixture states fixed while exercising the actual HTTP handler and database.
  aide.start = async () => {};
  const server = httpChannel(aide, log); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = (path: string) => fetch(base + path);
  const page = await (await get('/outputs/list?pageSize=1')).json() as OutputListView;
  assert.equal(page.total, 2); assert.equal(page.items.length, 1); assert.equal(page.pages, 2);
  for (const query of ['page=0', 'pageSize=101', 'phase=read', 'disclosure=bad', 'from=bad', 'from=2030-01-01T00:00:00Z&to=2020-01-01T00:00:00Z', 'unknown=x'])
    assert.equal((await get('/outputs/list?' + query)).status, 400, query);
  assert.equal((await get('/outputs/detail?id=session-output&uid=wrong')).status, 404);
  const detail = await (await get('/outputs/detail?id=session-output')).json() as import('../src/api/types.ts').OutputDetailView;
  assert.equal(detail.producer!.ref.kind, 'Topic', 'An execution without a Work producer belongs to the Topic Chief');
  assert.equal((await get('/outputs/filters')).status, 200);
  const query = new URLSearchParams({ id: output.metadata.name, uid: output.metadata.uid });
  assert.equal((await get('/outputs/session?' + query + '&sessionId=other')).status, 400);
  assert.equal((await get('/outputs/session?id=session-output&uid=wrong')).status, 404); assert.equal(reads, 0);
  assert.equal((await get('/outputs/session?' + query)).status, 200); assert.equal(reads, 1);
  assert.equal(await outputSession(aide, 'no-session', 'output:no-session'), undefined);
  aide.readSession = async () => ({ schema_version: 'agent-ledger/session@1', session: { source: 'pi', id: 'wrong' }, nodes: [] });
  await assert.rejects(() => outputSession(aide, output.metadata.name, output.metadata.uid), /identity mismatch/);
  for (const path of ['/inputs', '/?topic=a', '/people', '/addresses', '/outputs']) {
    const html = await (await get(path)).text();
    const nav = html.match(/<nav class="main-tabs".*?<\/nav>/)![0];
    assert.deepEqual([...nav.matchAll(/>(Inputs|Topics|Persons|Addresses|Outputs)<\/a>/g)].map(m => m[1]), ['Inputs', 'Topics', 'Persons', 'Addresses', 'Outputs']);
  }
  for (const path of ['/outputs.js', '/outputs.css']) assert.equal((await get(path)).status, 200);
});
