import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatMessage, MessageConnector } from "@compforge/aide-plugin";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SnapshotSchema, SnapshotMessages, collectSnapshot, triggerMessages, type Snapshot } from "../scripts/lark-replay/snapshot.ts";
import { replay, restrictSession } from "../scripts/lark-replay/run.ts";
import { report } from "../scripts/lark-replay/report.ts";
import { fakeOptions } from "./fake-harness.ts";

const start = "2026-10-19T00:00:00.000Z", end = "2026-10-19T01:00:00.000Z";
function message(id: string, at: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, chatId: "oc_test", content: id, createdAt: at, sender: { id: "ou_peer", type: "user" }, mentions: [], deleted: false, ...extra };
}
function fixture(): Snapshot {
  return { version: 1, collectedAt: end, start, end, identity: { accountId: "cli_test", userId: "ou_me" }, meIds: ["ou_me"],
    messages: [message("first", "2026-10-19T00:01:00.000Z"), message("future", "2026-10-19T00:30:00.000Z")],
    directIds: ["first", "future"], groupIds: [],
    coverage: ["direct", "group", "history", "thread"].map(operation => ({ operation: operation as Snapshot["coverage"][number]["operation"],
      key: operation === "history" ? "oc_test" : operation === "thread" ? "omt_test" : "", start, end, complete: true, pages: 1 })) };
}

test("Replay snapshot gates all read paths by cutoff and never guesses pre-edit content", async () => {
  const snapshot = fixture();
  snapshot.messages.forEach(m => { m.threadId = "omt_test"; });
  snapshot.messages.push(message("edited", start, { content: "future edit", updatedAt: end }));
  snapshot.directIds.push("edited");
  const connector = new SnapshotMessages(snapshot);
  connector.advance("2026-10-19T00:10:00.000Z");
  for (const page of [await connector.search({ start, end }), await connector.history({ chatId: "oc_test", start, end }),
    await connector.thread({ threadId: "omt_test" })]) assert.deepEqual(page.messages.map(m => m.id), ["first"]);
  assert.deepEqual(triggerMessages(snapshot).map(m => m.id), ["first", "future"]);
  connector.advance(end);
  assert.deepEqual((await connector.thread({ threadId: "omt_test" })).messages.map(m => m.id), ["first", "future"]);
  assert.throws(() => connector.advance(start), /advance/);
  assert.throws(() => connector.advance("2026-10-20T00:00:00Z"), /snapshot/);
});

test("Snapshot pagination, search membership and incomplete history remain distinct", async () => {
  const snapshot = fixture();
  snapshot.messages.push(message("context-only", start, { mentions: ["ou_me"] }));
  snapshot.coverage = snapshot.coverage.filter(c => c.operation !== "history");
  const connector = new SnapshotMessages(snapshot); connector.advance(end);
  const first = await connector.search({ start, end, chatType: "p2p", limit: 1 });
  assert.equal(first.hasMore, true);
  const second = await connector.search({ start, end, chatType: "p2p", pageToken: first.nextToken, limit: 1 });
  assert.deepEqual(second.messages.map(m => m.id), ["future"]);
  assert.equal(second.hasMore, false);
  assert.deepEqual((await connector.search({ start, end, chatType: "group" })).messages, []);
  const history = await connector.history({ chatId: "oc_test", start, end });
  assert.equal(history.messages.length, 3); assert.equal(history.hasMore, true); assert.equal(history.nextToken, undefined);
});

test("Collection follows pages, keeps context separate and records gaps without claiming completeness", async () => {
  let calls = 0;
  const original = fixture();
  const connector: MessageConnector = {
    identity: async () => original.identity,
    async search(query) {
      calls++;
      if (query.chatType === "group") return { messages: [], hasMore: false, observedThrough: end };
      return { messages: [original.messages[query.pageToken ? 1 : 0]!], hasMore: !query.pageToken,
        ...(!query.pageToken ? { nextToken: "next" } : {}), observedThrough: end };
    },
    async history() { throw new Error("Missing history scope"); },
    async thread() { throw new Error("Unexpected thread read"); },
  };
  const snapshot = await collectSnapshot(connector, { start, end, meIds: ["ou_me"], maxPages: 5 });
  assert.equal(calls, 3);
  assert.deepEqual(snapshot.directIds, ["first", "future"]);
  assert.equal(snapshot.coverage.filter(c => c.operation === "history" && !c.complete).length, 1);
  assert.equal(snapshot.coverage.find(c => c.operation === "history")!.end, end);
  const limited = await collectSnapshot(connector, { start, end, meIds: ["ou_me"], maxPages: 1 });
  assert.equal(limited.coverage[0]!.complete, false);
  assert.match(limited.coverage[0]!.error!, /budget/);
});

test("Replay allowlist excludes shell, tool discovery, work writes and delivery tools", () => {
  let active: string[] = [];
  restrictSession({ getAllTools: () => ["bash", "read", "write", "create_work", "request_work", "tool_search", "say", "assess_input", "group_topics", "read_chat_messages"].map(name => ({ name })),
    setActiveToolsByName(names: string[]) { active = names; } } as unknown as AgentSession);
  assert.deepEqual(active, ["say", "assess_input", "group_topics", "read_chat_messages"]);
});

test("Malformed discovery references are rejected before replay", () => {
  const snapshot = fixture(); snapshot.directIds.push("absent");
  assert.equal(SnapshotSchema.safeParse(snapshot).success, false);
});

test("An unacknowledged Input times out with failed-run evidence, never a success report", { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "aide-replay-timeout-"));
  try {
    mkdirSync(join(directory, "workspace"));
    const options = fakeOptions({ complete: false, notify: false, async execute() { throw new Error("No Work"); } },
      join(directory, "workspace"), [], join(directory, "state"));
    await assert.rejects(replay(fixture(), { directory, weave: false, batchSize: 20, timeoutMs: 1000,
      revision: "fixture", datasetHash: "fixture", createAdapter: options.createAdapter }), /did not finish/);
    const result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
    assert.equal(result.state, "error"); assert.equal(result.batches, 0);
    assert.ok(result.inputs.some((i: any) => Object.values(i.input.status.assess ?? {}).some((s: any) => !s.completedAt)));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Historical replay uses the real Source, routing, Chief receipts and report with a protocol fixture", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "aide-replay-test-"));
  try {
    mkdirSync(join(directory, "workspace"));
    const options = fakeOptions({ notify: false, async execute() { throw new Error("Replay must not execute Work"); } }, join(directory, "workspace"), [], join(directory, "state"));
    await replay(fixture(), { directory, weave: false, batchSize: 1, timeoutMs: 20_000, revision: "fixture", datasetHash: "fixture", createAdapter: options.createAdapter });
    const result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
    assert.equal(result.state, "completed"); assert.equal(result.inputs.length, 2);
    assert.equal(result.topics.length, 1); assert.equal(result.protocolFixture, true);
    assert.ok(result.inputs.every((i: any) => i.input.spec.origin === "source" && i.input.spec.originId === "personal.lark"));
    assert.ok(result.inputs.every((i: any) => i.timeline.some((e: any) => e.stage === "assess" && e.status === "completed")));
    const firstBatch = JSON.parse(readFileSync(join(directory, "batch-1.json"), "utf8"));
    assert.equal(firstBatch.inputs.length, 1);
    assert.ok(!JSON.stringify(firstBatch.inputs).includes('"content":"future"'));
    report(directory);
    assert.match(readFileSync(join(directory, "report.md"), "utf8"), /未对外发送/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
