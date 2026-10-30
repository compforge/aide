import { z } from "zod";
import type { ResourceClient, ResourceRef } from "@compforge/aide-plugin";

export const SensitivitySchema = z.enum(["L1", "L2", "L3"]);
export const VisibilitySchema = z.enum(["people", "topic", "root", "any"]);
export type Sensitivity = z.infer<typeof SensitivitySchema>;
export type Visibility = z.infer<typeof VisibilitySchema>;
export const sensitivityRank = (level: Sensitivity) => ({ L1: 1, L2: 2, L3: 3 })[level];
const scope = z.object({ apiVersion: z.string(), kind: z.literal("Topic"), namespace: z.literal("v1"), name: z.string(), uid: z.string().min(1) }).strict();
/** @spec Unknown classification is private and highly sensitive. Scope pins an authorization Topic incarnation, independent of material filing and tree moves. */
export const DisclosureFields = { sensitivity: SensitivitySchema.default("L3"), visibility: VisibilitySchema.default("people"), disclosureScope: scope.optional() };
export interface MaterialDisclosure { sensitivity?: Sensitivity; visibility?: Visibility; disclosureScope?: z.infer<typeof scope> }
/** Explicit participation is authorization data; recent associated people are not a participant directory. */
export async function disclosureScope(resources: ResourceClient, subject: ResourceRef, visibility: Visibility): Promise<MaterialDisclosure["disclosureScope"]> {
  if (visibility !== "topic" && visibility !== "root") return;
  type Ref = ResourceRef & { uid: string };
  const read = async (ref: ResourceRef) => {
    const resource = await resources.get<{ parentRef?: Ref }, { topic?: Ref }>(ref);
    if (!resource || resource.metadata.uid !== ref.uid || resource.metadata.deletionTimestamp) throw new Error("Disclosure scope no longer exists");
    return resource;
  };
  let resource = await read(subject);
  if (resource.kind !== "Topic") {
    if (!resource.status.topic) throw new Error("Disclosure requires an existing Topic scope");
    resource = await read(resource.status.topic);
  }
  const seen = new Set<string>();
  while (resource && visibility === "root" && resource.spec.parentRef) {
    if (seen.has(resource.metadata.uid)) throw new Error("Topic parent cycle");
    seen.add(resource.metadata.uid);
    const ref = resource.spec.parentRef;
    resource = await read(ref);
    if (resource?.metadata.uid !== ref.uid) throw new Error("Disclosure scope no longer exists");
  }
  if (!resource || resource.kind !== "Topic" || resource.metadata.deletionTimestamp) throw new Error("Disclosure requires an existing Topic scope");
  return { apiVersion: resource.apiVersion, kind: "Topic", namespace: "v1", name: resource.metadata.name, uid: resource.metadata.uid };
}
