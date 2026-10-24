import { fixtureAddress } from "./address-fixture.ts";
import type { OutputDraft, OutputView } from "../src/output.ts";
export function fixtureOutput(value: OutputDraft & { at: string; role?: "aide" }): OutputView {
  return { ...value, role: "aide", topicUid: "fixture", target: fixtureAddress(value.topicId), status: { phase: "pending", attempts: 0 } };
}
