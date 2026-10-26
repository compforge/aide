import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatMessage, MessageConnector } from "@compforge/aide-plugin";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SnapshotSchema, SnapshotMessages, collectSnapshot, triggerMessages, type Snapshot } from "../scripts/lark-replay/snapshot.ts";
import { replay, restrictSession } from "../scripts/lark-replay/run.ts";
import { report } from "../scripts/lark-replay/report.ts";
import { ReplayTimeoutSchema } from "../scripts/lark-replay/config.ts";
import { fakeOptions } from "./fake-harness.ts";

const start = "2026-10-19T00:00:00.000Z", end = "2026-10-19T01:00:00.000Z";
function message(id: string, at: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, chatId: "oc_test", content: id, createdAt: at, sender: { id: "ou_peer", type: "user" }, mentions: [], deleted: false, ...extra };
}
function fixture(): Snapshot {
  return { version: 1, collectedAt: end, start, end, identity: { accountId: "cli_test", userId: "ou_me" }, meIds: ["ou_me"],
    messages: [message("first", "2026-10-19T00:01:00.000Z"), message("future", "2026-10-19T00:30:00.000Z")],
    directIds: ["first", "future"], groupIds: [],
    coverage: ["direct", "group", "sent", "history", "thread"].map(operation => ({ operation: operation as Snapshot["coverage"][number]["operation"],
      key: operation === "history" ? "oc_test" : operation === "thread" ? "omt_test" : "",
      start: operation === "history" ? "2026-10-18T23:46:00.000Z" : start, end, complete: true, pages: 1 })) };
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
  await assert.rejects(connector.history({ chatId: "oc_test", start, end }), /Incomplete snapshot coverage: history oc_test/);
  assert.throws(() => connector.assertCoverage(), /Incomplete snapshot coverage/);
});

for (const operation of ["history", "thread"] as const) {
  test(`Incomplete ${operation} coverage fails replay even when Source catches the read error`, { timeout: 15_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "aide-replay-coverage-"));
    try {
      const snapshot = fixture();
      if (operation === "thread") snapshot.messages.forEach(message => { message.threadId = "omt_test"; });
      snapshot.coverage.find(coverage => coverage.operation === operation)!.complete = false;
      mkdirSync(join(directory, "workspace"));
      const options = fakeOptions({ notify: false, async execute() { throw new Error("No Work"); } },
        join(directory, "workspace"), [], join(directory, "state"));
      await assert.rejects(replay(snapshot, { directory, weave: false, batchSize: 20, timeoutMs: 5000,
        revision: "fixture", datasetHash: "fixture", createAdapter: options.createAdapter }), new RegExp(`Incomplete snapshot coverage: ${operation}`));
      const result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
      assert.equal(result.state, "error");
      assert.match(result.failure, new RegExp(`Incomplete snapshot coverage: ${operation}`));
      assert.equal(result.coverage.find((coverage: Snapshot["coverage"][number]) => coverage.operation === operation).complete, false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

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
  assert.equal(calls, 4);
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

test("Replay initialization failures release their directory and restore process state before retry", { timeout: 30_000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "aide-replay-init-"));
  try {
    writeFileSync(join(directory, "snapshot.json"), JSON.stringify(fixture()));
    // A fresh process keeps Hermes module initialization isolated from other test runtimes.
    const script = `
      import assert from "node:assert/strict";
      import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { main } from ${JSON.stringify(new URL("../scripts/lark-replay/main.ts", import.meta.url).href)};
      const root = ${JSON.stringify(directory)}, run = join(root, "run"), modelPath = join(root, "model.json");
      const args = ["replay", "--dataset", join(root, "snapshot.json"), "--run", run, "--model", modelPath,
        "--weave", "off", "--timeout-ms", "5000"];
      const valid = { provider: "replay-fixture", id: "test", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1" };
      delete process.env.REPLAY_MISSING_TEST_KEY;
      process.env.REPLAY_LOCAL_TEST_KEY = "local-fixture-only";
      const previousUmask = process.umask(0o022);
      for (const [model, error, agentDir] of [
        [{}, /provider/, undefined],
        [valid, /requires model.apiKeyEnv/, "original-agent-dir"],
        [{ ...valid, apiKeyEnv: "REPLAY_MISSING_TEST_KEY" }, /missing environment variable/, undefined],
        [{ ...valid, api: "unsupported-replay-api", apiKeyEnv: "REPLAY_LOCAL_TEST_KEY" }, /no registered SDK implementation/, "original-agent-dir"],
      ]) {
        if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = agentDir;
        writeFileSync(modelPath, JSON.stringify(model));
        await assert.rejects(main(args), error);
        assert.equal(existsSync(run), false, JSON.stringify(model));
        assert.equal(process.umask(), 0o022);
        assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir);
      }
      // Invalid timeout is rejected before claiming any directory.
      for (const timeout of ["1000", "2199", "4999"]) {
        await assert.rejects(main([...args.slice(0, -1), timeout]), /5000/);
        assert.equal(existsSync(run), false);
      }
      // Correct the model and retry exactly the same path; local connection failure must retain run evidence.
      writeFileSync(modelPath, JSON.stringify({ ...valid, apiKeyEnv: "REPLAY_LOCAL_TEST_KEY" }));
      await assert.rejects(main(args), /did not finish/);
      assert.equal(JSON.parse(readFileSync(join(run, "result.json"), "utf8")).state, "error");
      const manifest = readFileSync(join(run, "manifest.json"), "utf8");
      assert.equal(process.umask(), 0o022);
      assert.equal(process.env.PI_CODING_AGENT_DIR, "original-agent-dir");
      await assert.rejects(main(args), /EEXIST/);
      assert.equal(readFileSync(join(run, "manifest.json"), "utf8"), manifest);
      assert.equal(process.umask(), 0o022);
      assert.equal(process.env.PI_CODING_AGENT_DIR, "original-agent-dir");
      process.umask(previousUmask);
    `;
    const scriptPath = join(directory, "check.ts");
    writeFileSync(scriptPath, script);
    const result = spawnSync(process.execPath, [scriptPath], { encoding: "utf8", timeout: 25_000 });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}\n${result.stdout}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Replay timeout bounds leave room for quiet confirmation", () => {
  for (const timeout of [1000, 2199, 4999, 3_600_001]) assert.equal(ReplayTimeoutSchema.safeParse(timeout).success, false);
  assert.equal(ReplayTimeoutSchema.parse(5000), 5000);
  assert.equal(ReplayTimeoutSchema.parse(undefined), 180_000);
});

test("An unacknowledged Input times out with failed-run evidence, never a success report", { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "aide-replay-timeout-"));
  try {
    mkdirSync(join(directory, "workspace"));
    const options = fakeOptions({ complete: false, notify: false, async execute() { throw new Error("No Work"); } },
      join(directory, "workspace"), [], join(directory, "state"));
    await assert.rejects(replay(fixture(), { directory, weave: false, batchSize: 20, timeoutMs: 5000,
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
    await replay(fixture(), { directory, weave: false, batchSize: 1, timeoutMs: 5000, revision: "fixture", datasetHash: "fixture", createAdapter: options.createAdapter });
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


test("Replay collects Me group speech separately and never substitutes mention coverage for sent discovery", async () => {
  const mine = message("sent-to-colleague", "2026-10-19T00:05:00.000Z", {
    sender: { id: "ou_me", type: "user" }, mentions: ["ou_colleague"], content: "@colleague please update the configuration" });
  const context = message("context-only", "2026-10-19T00:06:00.000Z");
  const queries: import("@compforge/aide-plugin").MessageSearchQuery[] = [];
  const snapshot = await collectSnapshot({
    identity: async () => fixture().identity,
    async search(query) { queries.push(query); return { messages: query.senderIds ? [mine] : [], hasMore: false, observedThrough: end }; },
    async history() { return { messages: [mine, context], hasMore: false, observedThrough: end }; },
    async thread() { throw new Error("Unexpected thread read"); },
  }, { start, end, meIds: ["ou_me"], maxPages: 5 });
  assert.deepEqual(queries.filter(query => query.senderIds).map(query => query.senderIds), [["ou_me"]]);
  assert.deepEqual(triggerMessages(snapshot).map(m => m.id), [mine.id]);
  const connector = new SnapshotMessages(snapshot); connector.advance(end);
  assert.deepEqual((await connector.search({ start, end, chatType: "group", senderIds: ["ou_me"] })).messages.map(m => m.id), [mine.id]);
  assert.equal((await connector.search({ start, end, chatType: "group", senderIds: ["ou_peer"] })).messages.length, 0);
  snapshot.coverage = snapshot.coverage.filter(c => c.operation !== "sent");
  const incomplete = new SnapshotMessages(snapshot); incomplete.advance(end);
  await assert.rejects(incomplete.search({ start, end, chatType: "group", senderIds: ["ou_me"] }), /Incomplete snapshot coverage: sent/);
});
