import assert from "node:assert/strict";
import { test } from "node:test";
import { AideError, aideErrorDetails } from "@compforge/aide-common";
import { AideError as ConnectorAideError, DeliveryError, deliveryFailure } from "@compforge/aide-connector";
import { AideError as PluginAideError } from "@compforge/aide-plugin";
import { serializedError, restoredError } from "../src/protocol/ipc.ts";

test("Aide errors share one public contract and survive a JSON IPC round trip with false intact", () => {
  assert.equal(AideError, ConnectorAideError); assert.equal(AideError, PluginAideError);
  for (const retryable of [false, true]) for (const biz_code of [undefined, "230013"]) {
    const options = { retryable, code: "permission_denied", message: "Access denied", ...(biz_code ? { biz_code } : {}) };
    // Another SDK copy need not share the AideError constructor.
    const foreign = Object.assign(new Error(options.message), options, { name: "ConnectorError" });
    foreign.cause = new AideError({ retryable: false, code: "invalid_argument", message: "Invalid destination" });
    const wire = JSON.parse(JSON.stringify(serializedError(foreign)));
    const restored = restoredError(wire);
    assert(restored instanceof AideError); assert.equal(restored.name, "ConnectorError");
    assert.deepEqual(aideErrorDetails(restored), options);
    assert.equal(aideErrorDetails(restored.cause)!.code, "invalid_argument");
  }
});

test("Delivery errors retain replay diagnosis and retry deadlines across IPC", () => {
  for (const kind of ["retryable", "permanent", "unknown"] as const) {
    const failure = { kind, code: "rate_limited", biz_code: "230020", message: "Rejected", retryAfterMs: 5000 };
    const original = new DeliveryError(failure);
    assert(original instanceof AideError);
    const restored = restoredError(JSON.parse(JSON.stringify(serializedError(original))));
    assert.deepEqual(deliveryFailure(restored), failure);
    assert.deepEqual(aideErrorDetails(restored), { retryable: kind !== "permanent", code: failure.code, biz_code: failure.biz_code, message: failure.message });
  }
});

test("Malformed common diagnostics are not trusted or inferred from message text", () => {
  const valid = { retryable: false, code: "permission_denied", message: "Denied" };
  for (const invalid of [{ retryable: "false" }, { code: 403 }, { code: "" }, { biz_code: 230013 }, { biz_code: null }, { message: null }])
    assert.equal(aideErrorDetails({ ...valid, ...invalid }), undefined);
  assert.equal(aideErrorDetails(new Error("retryable: true code: timeout")), undefined);
  const ordinary = restoredError(JSON.parse(JSON.stringify(serializedError(new TypeError("Invalid value")))));
  assert.equal(ordinary.name, "TypeError"); assert.equal(ordinary.message, "Invalid value");
  assert.equal(aideErrorDetails(ordinary), undefined);
});
