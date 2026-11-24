import type { Resource, ResourceRef } from "@compforge/aide-plugin";
import { InputAttention, type ProcessingReceipt } from "../input/model.ts";

export const BATCH_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Batch" } as const;
/** @spec A sealed Batch is one Normal scheduling item containing a fixed set of Deferred Inputs.
 * @spec Input.status.batchId is the sole membership record; Chief owns Batch.assess, not member receipts.
 * @link docs/personal/batch.md
 */
export interface BatchSpec {
  topic: ResourceRef & { uid: string };
  attention: InputAttention.Normal;
  oldestAt: string;
}
export interface BatchStatus {
  phase: "preparing" | "ready" | "running" | "completed" | "failed" | "cancelled";
  assess?: ProcessingReceipt;
}
export type Batch = Resource<BatchSpec, BatchStatus>;
export const batchFinished = (batch: Batch): boolean => ["completed", "failed", "cancelled"].includes(batch.status.phase);
