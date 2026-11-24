import { isDeepStrictEqual } from "node:util";
import type { ResourceValidationContext } from "@compforge/aide-plugin";
import { deliveryFinished, type InputStatus } from "../input/model.ts";
import type { Input } from "../input/state.ts";
import { BATCH_TYPE, batchFinished, type Batch, type BatchSpec, type BatchStatus } from "./model.ts";
import { deliveryInUse } from "../topic/ownership.ts";
import { unclaimed } from "./members.ts";

/** Terminal Input receipts are a projection; Batch remains the execution authority. */
export function batchDelivery(batch: Batch): NonNullable<InputStatus["assess"]> {
  return { ...batch.status.assess, topic: batch.spec.topic };
}
/** @spec Membership is immutable after assignment. Members cannot be independently admitted, delivered or moved while Batch is open.
 * @case tests/input-batch.test.ts
 */
export function validateMembership(previous: Input, current: Input, context: ResourceValidationContext) {
  if (previous.status.batchId && (previous.status.batchId !== current.status.batchId || previous.status.batchAt !== current.status.batchAt))
    throw new Error("Batch membership and assignment time are immutable");
  if (!current.status.batchId) return;
  const batch = context.get<BatchSpec, BatchStatus>(BATCH_TYPE, current.status.batchId);
  if (!previous.status.batchId && (!batch || batch.metadata.deletionTimestamp || batch.status.phase !== "preparing" || !unclaimed(current)))
    throw new Error("Input batch is unavailable for membership changes");
  if (!batch) {
    if (deliveryFinished(previous.status.assess) && isDeepStrictEqual(previous.status.assess, current.status.assess)) return;
    throw new Error("Batch is unavailable");
  }
  if (["failed", "cancelled"].includes(batch.status.phase)
    && Object.keys(current.status.handle ?? {}).some(uid => !previous.status.handle?.[uid]))
    throw new Error("Failed Batch member cannot be assigned to new Work");
  if (!batchFinished(batch) && previous.status.topic?.uid !== current.status.topic?.uid)
    throw new Error("Finish Batch before moving a member");
  if (!isDeepStrictEqual(previous.status.assess, current.status.assess)) {
    const clean = (value: unknown) => JSON.parse(JSON.stringify(value));
    if (!batchFinished(batch) || !isDeepStrictEqual(clean(current.status.assess), clean(batchDelivery(batch))))
      throw new Error("Batch member delivery must project its terminal Batch receipt");
  }
}
export function memberCanEvict(input: Input, context: ResourceValidationContext): boolean {
  if (deliveryInUse(input.status.assess?.topic?.uid, input.status.assess?.executionId, context)) return false;
  if (!input.status.batchId) return true;
  const batch = context.get<BatchSpec, BatchStatus>(BATCH_TYPE, input.status.batchId);
  return (!batch || batchFinished(batch)) && deliveryFinished(input.status.assess);
}
