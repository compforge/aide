import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { HarnessEvent } from "../src/host/harness/adapter.ts";
import type { LogEntry } from "../src/host/logging.ts";
import { PiAdapter, type PiSession } from "../src/host/harness/pi/adapter.ts";

/** @case A failed invocation cannot accept more inputs, but independent calls reuse the native session. */
for (const rejects of [false, true]) test(`Pi compaction failure is scoped to the turn (native rejection: ${rejects})`, { timeout: 5000 }, async () => {
  let emit!: (event: AgentSessionEvent) => void;
  let aborted = 0, prompts = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let failed!: () => void;
  const failure = new Promise<void>(resolve => { failed = resolve; });
  const native: PiSession = {
    sessionId: "native", sessionFile: "/nonexistent/aide-test-pi-context.jsonl",
    subscribe(listener) { emit = listener; return () => {}; },
    async bindExtensions() {}, dispose() {}, clearQueue() { return { steering: [], followUp: [] }; },
    async followUp() { throw new Error("Must not queue after compaction failure"); },
    async steer() { throw new Error("Must not steer after compaction failure"); },
    extensionRunner: { async emit() {} } as unknown as PiSession["extensionRunner"],
    async abort() { aborted++; },
    async prompt() {
      prompts++;
      if (prompts === 1) {
        for (let i = 0; i < 2; i++) emit({ type: "compaction_end", reason: "threshold", result: undefined,
          aborted: false, willRetry: false, errorMessage: "summary token cap" });
        failed(); await gate;
        if (rejects) throw new Error("Native call aborted");
        emit({ type: "agent_settled", aborted: true });
        return;
      }
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Recovered" }],
        api: "openai-completions", provider: "fixture", model: "test", stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
      emit({ type: "agent_settled", aborted: false });
    },
  };
  const logs: LogEntry[] = [];
  const adapter = new PiAdapter({ createSession: async () => native, log: entry => logs.push(entry) });
  const events: HarnessEvent[] = [];
  let settled!: () => void;
  const ref = await adapter.create({ cwd: "/tmp" }, event => {
    events.push(event); if (event.kind === "state_update" && event.payload.state === "idle") settled();
  }, () => {});
  const input = { invocationId: "turn", messageId: "message", blocks: [{ type: "text" as const, text: "Review" }] };
  try {
    let done = new Promise<void>(resolve => { settled = resolve; });
    await adapter.prompt(ref, input); await failure;
    assert.equal((await adapter.followUp(ref, input)).accepted, false);
    assert.equal((await adapter.steer(ref, input)).accepted, false);
    release(); await done;
    assert.equal(aborted, 1);
    assert.equal(events.filter(e => e.kind === "state_update" && e.payload.stopReason === "error").length, 1);
    assert.ok(events.some(e => e.kind === "_aide_error_update" && e.payload.message.includes("summary token cap")));
    assert.ok(!events.some(e => e.kind === "agent_message" && e.payload.phase === "final"));
    assert.ok(logs.some(e => e.level === "error" && e.attributes?.sessionId === "native" && e.invocationId === "turn"));
    assert.equal(prompts, 1, "No automatic replay");

    done = new Promise<void>(resolve => { settled = resolve; });
    assert.equal((await adapter.prompt(ref, { ...input, invocationId: "next" })).accepted, true);
    await done;
    assert.equal(prompts, 2);
    assert.ok(events.some(e => e.invocationId === "next" && e.kind === "state_update" && e.payload.stopReason === "end_turn"));
  } finally { release(); await adapter.close(ref); }
});
