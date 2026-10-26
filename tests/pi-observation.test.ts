import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { PiObservations, ObservationConfigSchema } from "../agents/pi/observation.ts";
import { readObservation } from "@compforge/agent-pi/observation";

/** @case Concurrent sessions share a hard supplement budget; capture failures cannot fail agent events. */
test("Pi supplement budgets reserve active capacity and retain a readable gap without unbounded files", t => {
  const directory = mkdtempSync(join(tmpdir(), "aide-observation-budget-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const warnings: unknown[] = [];
  const log = { warn: (data: unknown) => { warnings.push(data); } };
  const config = ObservationConfigSchema.parse({ captureRequests: true, maxSessionBytes: 2048, maxBytes: 4096 });
  const observations = new PiObservations(directory, config, log);
  const first = SessionManager.inMemory(directory), second = SessionManager.inMemory(directory), third = SessionManager.inMemory(directory);
  const a = observations.open(first), b = observations.open(second), blocked = observations.open(third);
  assert.equal(blocked.manager, third); assert.equal(warnings.length, 1);
  let emit: ((event: AgentEvent) => void) | undefined;
  const session = { agent: { streamFunction() {}, subscribe(callback: (event: AgentEvent) => void) { emit = callback; return () => { emit = undefined; }; } }, dispose() {} } as unknown as AgentSession;
  a.bind(session);
  const oversized = { type: "tool_execution_start" as const, toolCallId: "t", toolName: "tool", args: { text: randomBytes(8000).toString("hex") } };
  assert.doesNotThrow(() => emit!(oversized));
  const files = readdirSync(directory);
  assert.equal(files.length, 1); assert.ok(statSync(join(directory, files[0]!)).size <= 2048);
  assert.match(readObservation(join(directory, files[0]!), first.getSessionId()).issues.join("\n"), /capacity/);
  const before = statSync(join(directory, files[0]!)).size;
  for (let n = 0; n < 10; n++) emit!(oversized);
  assert.equal(statSync(join(directory, files[0]!)).size, before);
  assert.equal(warnings.length, 2, "One warning for the budget and one for the stopped writer");
  session.dispose(); assert.equal(emit, undefined);
  const resumed = observations.open(third);
  assert.notEqual(resumed.manager, third, "Unused reservation is available after disposal");
  resumed.close(); b.close();
  assert.ok(readdirSync(directory).reduce((sum, file) => sum + statSync(join(directory, file)).size, 0) <= config.maxBytes);
});

test("Default capture creates no supplemental files and invalid disk budgets fail configuration", t => {
  const directory = mkdtempSync(join(tmpdir(), "aide-observation-off-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const observation = new PiObservations(directory, ObservationConfigSchema.parse({}), { warn() { assert.fail("Capture is disabled"); } });
  const native = SessionManager.inMemory(directory);
  assert.equal(observation.open(native).manager, native); assert.deepEqual(readdirSync(directory), []);
  assert.equal(ObservationConfigSchema.safeParse({ maxSessionBytes: 4096, maxBytes: 2048 }).success, false);
});

/** @case Export must not migrate or repair Pi-owned recovery files, even when their suffix is incomplete. */
test("Session observation parses native files without opening a writable manager", async t => {
  const directory = mkdtempSync(join(tmpdir(), "aide-observation-read-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "sessions"));
  const file = join(directory, "sessions", "native.jsonl");
  const at = new Date().toISOString();
  const raw = JSON.stringify({ type: "session", version: 2, id: "native", cwd: directory, timestamp: at }) + "\n" +
    JSON.stringify({ type: "message", id: "entry", parentId: null, timestamp: at, message: { role: "user", content: "original", timestamp: Date.now() } }) + "\n" + '{"incomplete":';
  writeFileSync(file, raw);
  const observation = new PiObservations(join(directory, "observations"), ObservationConfigSchema.parse({}), { warn() {} });
  const view = await observation.read(directory, { agentDir: directory }, "native");
  assert.equal(view.session.id, "native"); assert.ok(view.nodes.some(n => n.id === "entry"));
  assert.match(view.issues!.join("\n"), /incomplete/);
  assert.equal(readFileSync(file, "utf8"), raw);
  assert.deepEqual(readdirSync(join(directory, "sessions")), ["native.jsonl"]);
  await assert.rejects(observation.read(directory, { agentDir: directory }, "missing"), /missing/);
});
