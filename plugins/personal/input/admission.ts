import { Addresses } from "../address/service.ts";
import { addressRef } from "../address/model.ts";
import { PersonRefSchema } from "../person/model.ts";
import { InputSpecSchema } from "./definition.ts";
import type { InputSubmission } from "./model.ts";

/** @spec Sources contribute normalized place observations; Input persistence retains only the pinned Address and reply coordinates. */
export function admitInput(addresses: Addresses, raw: InputSubmission) {
  const { addressObservation, ...input } = raw;
  const participants = [...(raw.sender ? [PersonRefSchema.parse(raw.sender)] : []), ...raw.receivers ?? [], ...addressObservation?.people ?? []];
  const address = raw.source && addresses.observe(raw.source, participants, addressObservation);
  return InputSpecSchema.parse({ ...input, ...(address ? { source: addressRef(address) } : {}) });
}
