import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { InputSpecSchema } from "../plugins/personal/input/definition.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../plugins/personal/input/model.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { inputPrinter } from "../plugins/personal/input/printer.ts";
import { personRef, PERSON_TYPE, type PersonRef } from "../plugins/personal/person/model.ts";
import { knownReceivers, messageReceivers } from "../plugins/personal/person/receivers.ts";
import { topicPersons } from "../plugins/personal/topic/persons.ts";
import { moveMaterial, moveTopic } from "../plugins/personal/topic/organize.ts";
import { TOPIC_TYPE, type TopicResource } from "../plugins/personal/topic/model.ts";
import { SOURCES } from "../plugins/personal/source/definition.ts";
import { topicCandidates, topicParts } from "../plugins/personal/background.ts";
import { searchRootTopics } from "../plugins/personal/weave/candidates.ts";
import { topicTools } from "../plugins/personal/topic/tools.ts";
import type { ChatMessage } from "@compforge/aide-plugin";

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-topic-persons-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("No inference expected"); } }, home), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = aide.runtime.plugins.resourceClient("personal"), store = aide.personal.store;
  const person = async (id: string, name = id) => personRef(await aide.persons.observe({ provider: "lark", scope: "cli_people", id: `ou_${id}` }, name)) as PersonRef;
  const input = async (id: string, topic: TopicResource, spec: Partial<InputSpec> = {}) => resources.create<InputSpec, InputStatus>(INPUT_TYPE, {
    name: id, spec: { origin: "source", originId: "test", text: id, ...spec },
    status: { topic: resourceRef(topic), route: { completedAt: new Date().toISOString(), result: { topics: [resourceRef(topic)], reason: "test" } },
      assess: { completedAt: new Date().toISOString(), result: { summary: "done" } } },
  });
  return { aide, resources, store, person, input };
}

test("receiver facts are optional, immutable Person references; empty does not encode all", async t => {
  const f = fixture(t), root = await f.aide.topics.ensure("receivers"), receiver = await f.person("receiver");
  const base = { origin: "source", originId: "test", text: "fact" };
  assert.equal(InputSpecSchema.parse(base).receivers, undefined);
  assert.deepEqual(InputSpecSchema.parse({ ...base, receivers: [] }).receivers, []);
  for (const receivers of ["all", ["all"], [{ ...receiver, kind: "Audience" }], [{ ...receiver, uid: undefined }]])
    assert.equal(InputSpecSchema.safeParse({ ...base, receivers }).success, false);
  const fact = await f.input("addressed", root, { receivers: [receiver] });
  assert.deepEqual(f.aide.topics.inputStore.get("addressed")!.spec.receivers, [receiver]);
  assert.match(inputPrinter.describe(fact), /Explicit receiver Persons/);
  await assert.rejects(f.resources.replace(fact, { ...fact.spec, receivers: [] }, fact.status), /immutable/);
});

test("receiver resolution uses scoped verified humans and actual direct/reply evidence without expanding an audience", async t => {
  const f = fixture(t), known = await f.person("known");
  await f.aide.persons.observe({ provider: "lark", scope: "cli_elsewhere", id: "ou_foreign" });
  const before = (await f.aide.persons.list()).length;
  assert.deepEqual(await knownReceivers(f.aide.persons, "cli_people", ["ou_known", "ou_known", "ou_unknown", "ou_foreign", "all"]), [known]);
  assert.equal((await f.aide.persons.list()).length, before, "untyped IDs never create people");
  const message: ChatMessage = { id: "child", chatId: "chat", sender: { id: "ou_sender", type: "user" },
    mentions: [], content: "reply", parentId: "parent", deleted: false, createdAt: new Date().toISOString() };
  const parent = { ...message, id: "parent", sender: { id: "ou_parent", type: "user" } };
  const refs = await messageReceivers(f.aide.persons, "cli_people", message, [parent], "ou_account");
  const ids = await Promise.all(refs.map(ref => f.aide.persons.read(ref.name, ref.uid).then(p => p.spec.identities[0]!.id)));
  assert.deepEqual(ids.sort(), ["ou_account", "ou_parent"]);
  assert.deepEqual(await messageReceivers(f.aide.persons, "cli_people", { ...message, sender: { id: "ou_account", type: "user" } }, [] , "ou_account"), []);
  assert.deepEqual(await messageReceivers(f.aide.persons, "cli_people", message, [{ ...parent, chatId: "different" }]), []);
});

test("Topic people follow current subtree ownership and keep historical references separate from replacement Persons", async t => {
  const f = fixture(t), root = await f.aide.topics.ensure("root"), other = await f.aide.topics.ensure("other");
  const raw = await f.aide.topics.ensure("child");
  const child = await f.resources.replace(raw, { ...raw.spec, parentRef: resourceRef(root) }, raw.status);
  const sender = await f.person("sender", "Sender"), receiver = await f.person("receiver", "Receiver"), author = await f.person("author", "Author");
  const privatePerson = await f.aide.persons.read(sender.name, sender.uid);
  await f.aide.persons.summarize(sender.name, sender.uid, privatePerson.metadata.resourceVersion, "private-profile-marker");
  const fact = await f.input("conversation", child, { originId: SOURCES.lark.id, sender, receivers: [receiver, sender],
    text: "private-body-marker", observation: { message: { person: sender }, context: { messages: [
      { person: author }, { person: author, receivers: [receiver] },
      { person: { ...author, kind: "Topic" } }, { person: { ...author, namespace: "malformed" } }, { sender: { id: "ou_not-a-person-reference" } },
    ] } } });
  await f.input("elsewhere", other, { sender: await f.person("foreign") });
  const projected = topicPersons(f.store, root);
  assert.deepEqual(projected.items.map(p => p.ref.uid).sort(), [sender.uid, receiver.uid, author.uid].sort());
  assert.equal(projected.sampledInputs, 1);
  assert.doesNotMatch(JSON.stringify(projected), /private-profile-marker|private-body-marker|not-a-person-reference/);
  const active = await f.resources.patchStatus(root, { execution: { id: "chief", startedAt: new Date().toISOString() } });
  const move = (topicUid: string) => moveMaterial(f.resources, active, { kind: "Input", id: fact.metadata.name, topicUid, reason: "Reclassify current evidence" });
  await move(root.metadata.uid);
  assert.equal(topicPersons(f.store, child).items.length, 0);
  assert.deepEqual(f.aide.topics.inputStore.get(fact.metadata.name)!.status.route, fact.status.route, "Historical route does not control the derived view");
  assert.equal(topicPersons(f.store, root).items.length, 3);
  await move(child.metadata.uid);
  const independent = await moveTopic(f.resources, active, { uid: child.metadata.uid, parentUid: null, reason: "Independent responsibility" });
  assert.equal(topicPersons(f.store, root).items.length, 0);
  assert.ok(topicPersons(f.store, independent).items.some(p => p.ref.uid === author.uid));
  await f.resources.delete(PERSON_TYPE, receiver.name);
  f.store.resources.finalizeDeletion(PERSON_TYPE, receiver.name);
  await f.resources.create(PERSON_TYPE, { name: receiver.name, spec: { name: "Replacement", identities: [] }, status: { summary: "", recent: [], updatedAt: new Date().toISOString(), updatedBy: "user" } });
  const stale = topicPersons(f.store, independent).items.find(p => p.ref.uid === receiver.uid)!;
  assert.ok("unavailable" in stale && stale.unavailable);
  assert.equal("name" in stale, false);
  assert.deepEqual(topicPersons(f.store, independent, Date.now() + 8 * 86400_000).items, [], "old Inputs leave the rolling window");
});

test("bounded samples reach Route, Chief and Weave without changing grouping or exposing profiles", async t => {
  const f = fixture(t), root = await f.aide.topics.ensure("bounded");
  const refs = await Promise.all(Array.from({ length: 10 }, (_, i) => f.person(`p${i}`)));
  for (let i = 0; i < 52; i++) await f.input(`input-${i}`, root, { receivers: refs });
  const expected = topicPersons(f.store, root);
  assert.equal(expected.items.length, 8);
  assert.equal(expected.omittedPersons, 2);
  assert.equal(expected.sampledInputs, 50);
  assert.equal(expected.hasMoreInputs, true);
  assert.deepEqual(topicCandidates(f.store).find(t => t.uid === root.metadata.uid)!.persons, expected);
  const part = topicParts(f.store, root, root.spec.id).topic;
  assert.match(part, /sampledInputs/);
  const tools = topicTools(f.store, () => root);
  const read = await tools.find(t => t.name === "read_topic")!.execute("read", {}, undefined, undefined, {} as never);
  assert.match(JSON.stringify(read), /sampledInputs/);
  const roots = [];
  for (let i = 0; i < 12; i++) {
    const c = await f.aide.topics.ensure(`weave-${i}`);
    roots.push(await f.resources.patchStatus(c, { summary: "s".repeat(1200) }));
  }
  const page = searchRootTopics(roots, undefined, 0, 12, () => expected);
  assert.ok(page.nextOffset !== null, "person previews count against the page budget");
  assert.ok(JSON.stringify(page.items).length < 17000);
  assert.equal(page.items[0]!.persons!.items.length, 8);
  assert.equal(f.aide.topics.resource(root.spec.id)!.spec.parentRef, undefined, "people are evidence, not a grouping action");
});
