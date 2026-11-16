import type { ResourceReader } from "@compforge/aide-plugin";
import type { Input } from "../input/state.ts";
import type { Batch } from "./model.ts";
import { batchMembers, unclaimed } from "./members.ts";

export async function expandBatch(resources: ResourceReader, batch: Batch): Promise<readonly Input[]> {
  const members = await batchMembers(resources, batch);
  if (batch.metadata.deletionTimestamp || batch.status.phase !== "ready" || !members.length || members.some(i => !unclaimed(i)))
    throw new Error("Batch members unavailable for admission");
  return members;
}
