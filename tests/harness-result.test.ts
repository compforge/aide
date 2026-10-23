import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexItemLifecycleDrafts } from "../src/host/harness/codex/mapping.ts";
import { codexHistoryTurns } from "../src/host/harness/codex/native-session.ts";
import { HarnessFixtures } from "./harness-fixture.ts";

const progress = { type: "agentMessage", id: "progress", phase: "commentary", text: "我先检查当前可访问的代码仓。" };
const answer = { type: "agentMessage", id: "answer", phase: "final_answer", text: '{"action":"done"}' };

test("Codex live and imported messages retain finality in native history normalization and live invocation results", (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-final-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const mode of ["live", "history"] as const) {
    const sessions = new HarnessFixtures(root);
    const session = sessions.create({ cwd: "/repo" });
    const drafts = mode === "live" ? [progress, answer].flatMap((item) => codexItemLifecycleDrafts("completed", item))
      : codexHistoryTurns([{ id: "turn", status: "completed", itemsView: "full", items: [progress, answer] }])[0]!.events!.map((entry) => entry.event);
    for (const draft of drafts) session.appendEvent({ ...draft, source: { type: "harness", harnessName: "codex" },
      harness: "codex", harnessName: "codex", runtimeId: "main", invocationId: "turn" });
    assert.equal(session.projection.messages.get("progress")?.kind, "output");
    const summary = session.summarizeInvocation("turn");
    assert.equal(summary.agentText, progress.text + "\n" + answer.text);
    assert.equal(summary.finalText, answer.text);
    assert.equal(session.summarizeInvocation("turn").finalText, answer.text);
  }
});

test("JSON-shaped commentary or unclassified messages are never promoted to a final answer", (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-no-final-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const phase of ["commentary", undefined, "unknown-future-phase"]) {
    const session = new HarnessFixtures(root).create({ cwd: "/repo" });
    for (const draft of codexItemLifecycleDrafts("completed", { ...answer, phase })) {
      session.appendEvent({ ...draft, source: { type: "harness", harnessName: "codex" }, harness: "codex", invocationId: "turn" });
    }
    const summary = session.summarizeInvocation("turn");
    assert.equal(summary.agentText, answer.text);
    assert.equal(summary.finalText, undefined);
  }
});
