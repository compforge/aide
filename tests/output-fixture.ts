import { personRefs } from "../plugins/personal/person/model.ts";
import { fixtureAddress, allowAddress } from "./address-fixture.ts";
import type { OutputDraft, OutputView } from "../plugins/personal/output/view.ts";
export function fixtureOutput(value: OutputDraft & { at: string; role?: "aide" }): OutputView {
  return { ...value, role: "aide", topicUid: "fixture", target: fixtureAddress(value.topicId), status: { phase: "pending", attempts: 0, disclosure: { decision: "allowed", reason: "Transport fixture", checkedAt: new Date().toISOString(), fingerprint: "fixture" }, delivery: { address: { apiVersion: "aide.dev/v1alpha1", kind: "Address", namespace: "v1", name: "fixture", uid: "fixture" }, target: value.target ?? fixtureAddress(value.topicId), stream: { apiVersion: "aide.dev/v1alpha1", kind: "Stream", namespace: "v1", name: "fixture", uid: "fixture-stream" }, receivers: value.receivers ?? [] } } };
}

/** Transport tests start after the disclosure boundary; permission behavior is tested with OutputDisclosure itself. */
export function approveFixtureOutput(store: import("../plugins/personal/output/store.ts").OutputStore, id: string, delivered = false) {
  const output = store.get(id)!;
  if (!output.status.delivery) allowAddress(store.storage.home, output.spec.target);
  if (!output.status.delivery) store.update(id, status => ({ ...status,
    disclosure: { decision: "allowed", reason: "Transport fixture", checkedAt: new Date().toISOString(), fingerprint: "fixture" },
    delivery: { address: output.spec.target, target: store.destination(output), stream: output.spec.stream, receivers: output.spec.receivers ?? personRefs([]) } }));
  if (delivered) store.delivered(id);
}

export function transportFixture(aide: import("../src/app.ts").Aide) {
  aide.outputStore.check = async id => approveFixtureOutput(aide.outputStore, id);
}
