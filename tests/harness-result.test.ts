import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexItemLifecycleDrafts } from "../src/runtime/harness/codex/mapping.ts";
import { codexHistoryTurns } from "../src/runtime/harness/codex/native-session.ts";
import { SessionStore } from "../src/runtime/store/store.ts";

const progress = { type: "agentMessage", id: "progress", phase: "commentary", text: "我先检查当前可访问的代码仓。" };
const answer = { type: "agentMessage", id: "answer", phase: "final_answer", text: '{"action":"done"}' };

test("Codex live and imported messages retain finality across ledger replay and Turn summary", (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-final-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const mode of ["live", "history"] as const) {
    const sessions = new SessionStore(root);
    const session = sessions.createSession({ cwd: "/repo" });
    const drafts = mode === "live" ? [progress, answer].flatMap((item) => codexItemLifecycleDrafts("completed", item))
      : codexHistoryTurns([{ id: "turn", status: "completed", itemsView: "full", items: [progress, answer] }])[0]!.events!.map((entry) => entry.event);
    for (const draft of drafts) session.appendEvent({ ...draft, source: { type: "harness", harnessTargetId: "codex" },
      harness: "codex", harnessTargetId: "codex", laneId: "main", turnId: "turn" });
    const reopened = sessions.openSession(session.id);
    assert.equal(reopened.loadState().messages.get("progress")?.kind, "output");
    const summary = reopened.summarizeTurn("turn");
    assert.equal(summary.agentText, progress.text + "\n" + answer.text);
    assert.equal(summary.finalText, answer.text);
    assert.equal(sessions.openSession(session.id).summarizeTurn("turn").finalText, answer.text);
  }
});

test("JSON-shaped commentary or unclassified messages are never promoted to a final answer", (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-no-final-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const phase of ["commentary", undefined, "unknown-future-phase"]) {
    const session = new SessionStore(root).createSession({ cwd: "/repo" });
    for (const draft of codexItemLifecycleDrafts("completed", { ...answer, phase })) {
      session.appendEvent({ ...draft, source: { type: "harness", harnessTargetId: "codex" }, harness: "codex", turnId: "turn" });
    }
    const summary = session.summarizeTurn("turn");
    assert.equal(summary.agentText, answer.text);
    assert.equal(summary.finalText, undefined);
  }
});
