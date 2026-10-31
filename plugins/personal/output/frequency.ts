import type { ResourceValidationContext } from "@compforge/aide-plugin";
import { PERSON_TYPE, type Person, type PersonStatus } from "../person/model.ts";
import { deliveryDurationMs, deliveryHistoryMs } from "../person/delivery.ts";
import { OUTPUT_TYPE, type Output, type OutputSpec, type OutputStatus } from "./model.ts";
import type { OutputStore } from "./store.ts";

/** @spec Successful delivery history is the only frequency ledger. Query at most the configured threshold per Person.
 * @why The Nth newest receipt determines release even after lowering a previous limit.
 * @link docs/personal/output.md#投递频控
 * @case tests/output-frequency.test.ts
 */
export function nextDeliveryAt(store: OutputStore, output: Readonly<Output>, now = Date.now()): number {
  let next = now;
  for (const ref of output.status.delivery?.receivers ?? []) {
    const person = store.resources.find<Person, PersonStatus>(PERSON_TYPE, ref.name, ref.namespace);
    if (!person || person.metadata.uid !== ref.uid || person.metadata.deletionTimestamp) continue;
    const policy = person.spec.delivery;
    if (!deliveryHistoryMs(policy)) continue;
    const recent = store.resources.page<OutputSpec, OutputStatus>(OUTPUT_TYPE, {
      limit: policy?.window?.maxMessages ?? 1, direction: "desc",
      matchIndex: { name: "deliveredPerson", value: ref.uid },
    }).items;
    const latest = recent[0]?.status.deliveredAt;
    if (latest && policy?.minInterval) next = Math.max(next, Date.parse(latest) + deliveryDurationMs(policy.minInterval));
    const threshold = policy?.window && recent[policy.window.maxMessages - 1]?.status.deliveredAt;
    if (threshold && policy?.window) next = Math.max(next, Date.parse(threshold) + deliveryDurationMs(policy.window.duration));
  }
  return next;
}

/** @spec Eviction rechecks current Person policy in the storage transaction; needed delivery evidence cannot be reclaimed.
 * @link docs/personal/output.md#投递频控
 * @case tests/output-frequency.test.ts
 */
export function canEvictOutput(output: Readonly<Output>, context: ResourceValidationContext): boolean {
  if (output.status.phase !== "delivered" || !output.status.deliveredAt) return true;
  const delivered = Date.parse(output.status.deliveredAt), now = Date.now();
  for (const ref of output.status.delivery?.receivers ?? []) {
    const person = context.get<Person, PersonStatus>(PERSON_TYPE, ref.uid);
    if (person && !person.metadata.deletionTimestamp && delivered + deliveryHistoryMs(person.spec.delivery) > now) return false;
  }
  return true;
}
