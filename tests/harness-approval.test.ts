import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/host/store/store.ts";
import { HarnessApprovalContinuations } from "../src/host/approval/harness.ts";
import { requestResult } from "../src/host/approval/resolution.ts";
import type { ApprovalDraft } from "../src/host/approval/types.ts";

const permission: ApprovalDraft = { kind: "permission", title: "Run tool?", options: [
  { optionId: "allow", name: "Allow once", polarity: "allow", lifetime: "once" },
  { optionId: "reject", name: "Reject", polarity: "reject", lifetime: "once" },
] };
test("Native permission validates explicit choices, persists rejection and cannot be settled twice", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aide-approval-"));
  const storage = new SessionStore(home), session = storage.createSession({ id: "approval", cwd: home });
  t.after(async () => { await session.closeLogs(); rmSync(home, { recursive: true, force: true }); });
  const pending = new HarnessApprovalContinuations<{ target: { id: string }; contextId: string }>(
    (binding, event, source) => { session.appendEvent({ ...event, source, harnessTargetId: binding.target.id, contextId: binding.contextId }); },
    () => {}, () => session.projection);
  const wait = pending.open({ target: { id: "codex" }, contextId: "main" }, permission, "turn");
  const id = [...session.projection.approvals.keys()][0]!;
  assert.equal(pending.complete(id, { kind: "permission", outcome: "selected", optionId: "invented" }), false);
  assert.equal(session.projection.approvals.get(id)!.request.status, "pending");
  assert.equal(pending.complete(id, { kind: "permission", outcome: "selected", optionId: "reject" }), true);
  assert.deepEqual(await wait, { kind: "permission", outcome: "selected", optionId: "reject" });
  assert.equal(pending.complete(id, { kind: "permission", outcome: "selected", optionId: "allow" }), false);
  const reopened = storage.openSession(session.id);
  assert.deepEqual(requestResult(reopened.projection, id), { kind: "permission", outcome: "selected", optionId: "reject" });
  await reopened.closeLogs();
  const hook = pending.open({ target: { id: "codex" }, contextId: "main" }, { kind: "hook_trust", harnessName: "codex", hooks: [] }, "next-turn");
  pending.cancelForInvocation("next-turn");
  assert.deepEqual(await hook, { kind: "cancelled", reason: "invocation" });
});
