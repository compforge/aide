import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { HarnessEvent } from "../src/host/harness/adapter.ts";
import { PiAdapter, type PiSession } from "../src/host/harness/pi/adapter.ts";

/** @case Failed native compaction cannot fall through into another model request on the same context. */
test("Pi aborts failed compaction once and rejects later turns until context replacement", async () => {
  let emit!: (event: AgentSessionEvent) => void;
  let aborted = 0, prompts = 0;
  const native: PiSession = {
    sessionId: "native", sessionFile: "/nonexistent/aide-test-pi-context.jsonl",
    subscribe(listener) { emit = listener; return () => {}; },
    async bindExtensions() {}, dispose() {},
    extensionRunner: { async emit() {} } as unknown as PiSession["extensionRunner"],
    async abort() { aborted++; },
    async prompt() {
      prompts++;
      emit({ type: "compaction_end", reason: "overflow", result: undefined, aborted: false, willRetry: true, errorMessage: "summary overflow" });
      emit({ type: "agent_settled", aborted: false });
    },
  };
  const adapter = new PiAdapter({ createSession: async () => native });
  const events: HarnessEvent[] = [];
  let settled!: () => void;
  const done = new Promise<void>((resolve) => { settled = resolve; });
  const ref = await adapter.open({ cwd: "/tmp" }, (event) => {
    events.push(event); if (event.kind === "state_update" && event.payload.state === "idle") settled();
  }, () => {});
  const input = { invocationId: "turn", messageId: "message", blocks: [{ type: "text" as const, text: "Review" }] };
  try {
    await adapter.sendTurn(ref, input); await done;
    assert.equal(aborted, 1);
    assert.equal(events.filter((e) => e.kind === "state_update" && e.payload.stopReason === "error").length, 1);
    await assert.rejects(adapter.sendTurn(ref, { ...input, invocationId: "next" }), /compaction failed/);
    assert.equal(prompts, 1);
  } finally { await adapter.close(ref); }
});
