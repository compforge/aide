import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { OutputStore } from "../plugins/personal/output/store.ts";
import { OutputDelivery, type OutputTransport } from "../plugins/personal/output/delivery.ts";
import { nextDeliveryAt } from "../plugins/personal/output/frequency.ts";
import { PersonDefinition } from "../plugins/personal/person/definition.ts";
import { PERSON_TYPE, PersonSchema, personRef, personRefs, type PersonResource } from "../plugins/personal/person/model.ts";
import type { PersonDelivery } from "../plugins/personal/person/delivery.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { ResourceCapacityError, ResourceStorageConfigSchema } from "../src/host/resource/storage.ts";
import { webAddress, larkAddress, assertChannelDelivery } from "../src/channel/address.ts";
import { approveFixtureOutput } from "./output-fixture.ts";
import { registerOutputs } from "../plugins/personal/output/reconcile.ts";
import type { PluginContext } from "@compforge/aide-plugin";

const log = pino({ level: "silent" });
async function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "output-frequency-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new OutputStore(home, target => assertChannelDelivery(target, ["app"]));
  store.storage.register("personal", [PersonDefinition]);
  const client = createResourceClient(store.resources);
  const person = async (name: string, delivery?: PersonDelivery) => await client.create(PERSON_TYPE, { name,
    spec: { name, identities: [], ...(delivery ? { delivery } : {}) }, status: { updatedAt: new Date().toISOString(), updatedBy: "user" } }) as PersonResource;
  const output = (id: string, people: PersonResource[], target = webAddress("topic")) => {
    store.create("topic", id, { text: id, topicId: "topic", topic: { apiVersion: "aide.dev/v1alpha4", kind: "Topic", namespace: "v1", name: "topic", uid: "topic" },
      target, receivers: personRefs(people.map(personRef)) });
    approveFixtureOutput(store, id);
    return store.get(id)!;
  };
  store.check = async id => approveFixtureOutput(store, id);
  const delivered = (id: string, people: PersonResource[], at: number) => {
    output(id, people);
    store.update(id, s => ({ ...s, phase: "delivered", deliveredAt: new Date(at).toISOString() }));
  };
  const service = (send: OutputTransport["send"] = async () => undefined) => new OutputDelivery(store, () => ({ replay: "idempotent", send }), log);
  return { home, store, client, person, output, delivered, service };
}

test("Person frequency defaults to unlimited and validates paired, bounded window settings", () => {
  assert.equal(PersonSchema.parse({ name: "A", identities: [] }).delivery, undefined);
  assert.deepEqual(PersonSchema.parse({ name: "A", delivery: { window: { duration: "1h", maxMessages: 10 }, minInterval: "1m" } }).delivery,
    { window: { duration: "1h", maxMessages: 10 }, minInterval: "1m" });
  for (const delivery of [{ window: { duration: "1h" } }, { minInterval: "0s" }, { minInterval: "wrong" },
    { window: { duration: "1d", maxMessages: 1001 } }, { minInterval: "99999999999999999d" }])
    assert.throws(() => PersonSchema.parse({ name: "A", delivery }));
});

test("sliding window and interval use bounded newest receipts across channels and ignore other receivers", async t => {
  const f = await setup(t), now = Date.now();
  const a = await f.person("a", { window: { duration: "1h", maxMessages: 2 }, minInterval: "1m" }), b = await f.person("b");
  f.delivered("a-old", [a], now - 7200_000);
  f.delivered("a-one", [a], now - 50_000);
  f.delivered("a-two", [a], now - 40_000);
  f.delivered("a-three", [a], now - 30_000);
  f.delivered("other", [b], now);
  const pending = f.output("new-channel", [a], larkAddress("app", "chat"));
  const page = f.store.resources.page.bind(f.store.resources), limits: number[] = [];
  f.store.resources.page = ((type, options) => { limits.push(options.limit); return page(type, options); }) as typeof page;
  // Lowering maxMessages below the existing count requires the Nth newest receipt, not the oldest in the window.
  assert.equal(nextDeliveryAt(f.store, pending, now), now - 40_000 + 3600_000);
  assert.deepEqual(limits, [2]);
  assert.equal(nextDeliveryAt(f.store, pending, now - 40_000 + 3600_000), now - 40_000 + 3600_000);
  let sends = 0;
  const result = await f.service(async () => { sends++; return undefined; }).reconcile(pending.metadata.name);
  assert.ok(result.requeueAfterMs! > 3500_000);
  assert.equal(sends, 0);
  assert.equal(f.store.get(pending.metadata.name)!.status.attempts, 0);
  assert.equal(f.store.get(pending.metadata.name)!.status.phase, "pending");
  assert.equal(f.store.get(pending.metadata.name)!.status.lastError, undefined);
  assert.equal(f.store.get(pending.metadata.name)!.status.deliveryWait?.reason, "frequency");
});

test("concurrent sends share receiver execution rights across delivery instances; multi-person acquisition is all-or-nothing", async t => {
  const f = await setup(t), a = await f.person("a", { minInterval: "1m" }), b = await f.person("b");
  f.output("first", [a]); f.output("second", [a]); f.output("group", [b, a]); f.output("independent", [b]);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(r => { entered = r; }), blocked = new Promise<void>(r => { release = r; });
  const sends: string[] = [];
  const send: OutputTransport["send"] = async m => { sends.push(m.id); if (m.id === "first") { entered(); await blocked; } return undefined; };
  const first = f.service(send).reconcile("first");
  await started;
  try {
    assert.ok((await f.service(send).reconcile("second")).requeueAfterMs);
    assert.ok((await f.service(send).reconcile("group")).requeueAfterMs);
    await f.service(send).reconcile("independent");
    assert.deepEqual(sends, ["first", "independent"], "failed group acquisition must not hold B");
  } finally { release(); await first; }
  assert.ok((await f.service(send).reconcile("second")).requeueAfterMs! > 50_000);
  assert.equal(f.store.get("second")!.status.attempts, 0);
});

test("only successful delivery counts; new service instances reconstruct quota from Output history", async t => {
  const f = await setup(t), a = await f.person("a", { window: { duration: "1h", maxMessages: 1 } });
  f.output("failed", [a]); f.output("successful", [a]); f.output("waiting", [a]);
  await assert.rejects(f.service(async () => { throw new Error("offline"); }).reconcile("failed"), /transport failed/);
  assert.equal(f.store.get("failed")!.status.attempts, 1);
  await f.service().reconcile("successful");
  assert.equal(f.store.get("successful")!.status.phase, "delivered");
  const reopened = new OutputStore(f.home);
  reopened.check = f.store.check;
  const service = new OutputDelivery(reopened, () => ({ replay: "idempotent", send: async () => assert.fail("quota survived restart") }), log);
  assert.ok((await service.reconcile("waiting")).requeueAfterMs! > 3500_000);
  assert.ok((await service.reconcile("failed")).requeueAfterMs! > 3500_000);
  assert.equal(f.store.get("failed")!.status.attempts, 1);
});

test("actual fallback audience determines frequency; policy changes after awaited preparation are rechecked", async t => {
  const f = await setup(t), a = await f.person("a", { minInterval: "1h" }), me = await f.person("me", { minInterval: "1m" });
  f.delivered("me-receipt", [me], Date.now());
  f.output("fallback", [a]);
  f.store.update("fallback", s => ({ ...s, delivery: { ...s.delivery!, receivers: personRefs([personRef(me)]) } }));
  const result = await f.service().reconcile("fallback");
  assert.ok(result.requeueAfterMs! > 50_000 && result.requeueAfterMs! <= 60_000);
  const b = await f.person("b");
  f.delivered("b-receipt", [b], Date.now()); f.output("changed", [b]);
  const service = new OutputDelivery(f.store, async () => {
    await f.client.patch(b, { type: "merge", value: { spec: { delivery: { minInterval: "1h" } } } });
    return { replay: "idempotent", send: async () => assert.fail("new policy must apply") };
  }, log);
  assert.ok((await service.reconcile("changed")).requeueAfterMs! > 3500_000);
});

test("frequency history is protected from capacity eviction until policy no longer needs it", async t => {
  const f = await setup(t), a = await f.person("a", { minInterval: "1h" });
  f.delivered("protected", [a], Date.now());
  f.store.storage.configure(ResourceStorageConfigSchema.parse({ kinds: { "aide.dev/Output": { maxCount: 1 } } }));
  assert.throws(() => f.output("new", [a]), ResourceCapacityError);
  assert.ok(f.store.get("protected"));
  await f.client.patch(a, { type: "merge", value: { spec: { delivery: null } } });
  f.output("new", [a]);
  assert.equal(f.store.get("protected"), undefined);
});

test("Person policy watch wakes pending Outputs and relaxed policy ignores the previous deadline", async t => {
  const f = await setup(t), a = await f.person("a", { minInterval: "1h" });
  f.delivered("history", [a], Date.now()); f.output("pending", [a]);
  await f.service().reconcile("pending");
  let registration: any;
  registerOutputs({ resources: f.client, controllers: { register: (r: unknown) => { registration = r; } } } as PluginContext);
  const after = await f.client.patch(a, { type: "merge", value: { spec: { delivery: null } } });
  const requests = await registration.watches[0].handler.update({ oldObject: a, newObject: after });
  assert.deepEqual(requests, [{ name: "pending", namespace: "v1" }]);
  await f.service().reconcile("pending");
  assert.equal(f.store.get("pending")!.status.phase, "delivered");
  assert.equal(f.store.get("pending")!.status.deliveryWait, undefined);
});


test("real Runner schedules frequency waits and Person changes wake an old deadline", { timeout: 15_000 }, async t => {
  const { PluginInstanceStore } = await import("../src/host/plugin/instance.ts");
  const { Manager } = await import("../src/host/plugin/manager.ts");
  const { PluginSupervisor } = await import("../src/host/plugin/runner/index.ts");
  const { OUTPUT_TYPE } = await import("../plugins/personal/output/model.ts");
  const f = await setup(t), a = await f.person("a", { minInterval: "500ms" });
  const instances = new PluginInstanceStore({ home: f.home });
  instances.create({ pluginInstanceId: "personal", pluginId: "tests/output-frequency", marketplace: "fixtures", packageVersion: "1.0.0" });
  const sends: number[] = [], errors: unknown[] = [];
  const delivery = f.service(async () => { sends.push(Date.now()); return undefined; });
  const makeManager = () => new Manager({ instances, pluginSupervisor: new PluginSupervisor(),
    onRunnerFailure: failure => errors.push(failure.error), onActivationError: failure => errors.push(failure.error),
    actions: { "personal/reconcile_output": async (_context, input) => delivery.reconcile((input as { id: string }).id) },
    async loadPackageEntry(pluginId, version) { return { pluginId, version,
      entryUrl: new URL("./fixtures/output-frequency-plugin.ts", import.meta.url).href,
      resourcesUrl: new URL("./fixtures/output-frequency-definitions.ts", import.meta.url).href }; },
  });
  let manager = makeManager();
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) { if (Date.now() > deadline) assert.fail(`Runner did not progress: ${JSON.stringify(errors)}`); await new Promise(r => setTimeout(r, 10)); }
  };
  try {
    await manager.start();
    const create = async (name: string) => manager.resourceClient("personal").create(OUTPUT_TYPE, { name, spec: {
      text: name, topicId: "topic", topic: { apiVersion: "aide.dev/v1alpha4", kind: "Topic", namespace: "v1", name: "topic", uid: "topic" },
      target: webAddress("topic"), receivers: personRefs([personRef(a)]),
    }, status: { phase: "pending", attempts: 0 } });
    await create("one"); await waitFor(() => sends.length === 1);
    await create("two"); await waitFor(() => !!f.store.get("two")?.status.deliveryWait);
    await manager.close();
    manager = makeManager();
    await manager.start();
    await waitFor(() => sends.length === 2);
    assert.ok(sends[1]! - sends[0]! >= 500);
    const restarted = manager.resourceClient("personal");
    await restarted.patch(a, { type: "merge", value: { spec: { delivery: { minInterval: "1h" } } } });
    await create("three"); await waitFor(() => f.store.get("three")?.status.deliveryWait?.reason === "frequency");
    await restarted.patch(a, { type: "merge", value: { spec: { delivery: null } } });
    await waitFor(() => sends.length === 3);
    assert.equal(f.store.get("three")!.status.phase, "delivered");
    assert.deepEqual(errors, []);
  } finally { await manager.close(); }
});
