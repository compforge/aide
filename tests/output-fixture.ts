import { fixtureAddress } from "./address-fixture.ts";
import type { OutputDraft, OutputView } from "../src/output.ts";
export function fixtureOutput(value: OutputDraft & { at: string; role?: "aide" }): OutputView {
  return { ...value, role: "aide", topicUid: "fixture", target: fixtureAddress(value.topicId), status: { phase: "pending", attempts: 0, disclosure: { decision: "allowed", reason: "Transport fixture", checkedAt: new Date().toISOString(), fingerprint: "fixture" }, delivery: { target: value.target ?? fixtureAddress(value.topicId), text: value.text, receivers: value.receivers ?? [] } } };
}

/** Transport tests start after the disclosure boundary; permission behavior is tested with OutputDisclosure itself. */
export function approveFixtureOutput(store: import("../plugins/personal/output/store.ts").OutputStore, id: string, delivered = false) {
  const output = store.get(id)!;
  if (!output.status.delivery) store.update(id, status => ({ ...status,
    disclosure: { decision: "allowed", reason: "Transport fixture", checkedAt: new Date().toISOString(), fingerprint: "fixture" },
    delivery: { target: output.spec.target, text: output.spec.text, receivers: output.spec.receivers ?? [] } }));
  if (delivered) store.delivered(id);
}
