import { Addresses } from "../address/service.ts";
import { addressRef } from "../address/model.ts";
import { PersonRefSchema } from "../person/model.ts";
import { InputSpecSchema } from "./definition.ts";
import type { InputSubmission } from "./model.ts";

/** @spec Address participants come from the sender and explicit place observations, never message mentions.
 * @why A person mentioned in a direct message does not participate in that conversation.
 * @case tests/lark.test.ts
 * @link docs/personal/address.md
 */
export function admitInput(addresses: Addresses, raw: InputSubmission) {
  const { addressObservation, ...input } = raw;
  const participants = [...(raw.sender ? [PersonRefSchema.parse(raw.sender)] : []), ...addressObservation?.people ?? []];
  const address = raw.source && addresses.observe(raw.source, participants, addressObservation);
  return InputSpecSchema.parse({ ...input, ...(address ? { source: addressRef(address) } : {}) });
}
