import type { ResourceValidationContext } from "@compforge/aide-plugin";
import type { Input } from "../input/state.ts";
import { BATCH_TYPE, type BatchSpec, type BatchStatus } from "./model.ts";

/** Read the authoritative Batch while member receipt projection may still be pending. */
export function batchForInput(resources: Pick<ResourceValidationContext, "page">, input: Input) {
  return input.status.batchId ? resources.page<BatchSpec, BatchStatus>(BATCH_TYPE,
    { matchIndex: { name: "uid", value: input.status.batchId }, limit: 1 }).items[0] : undefined;
}
