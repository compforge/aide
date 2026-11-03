import { z } from "zod";

export const SensitivitySchema = z.enum(["L1", "L2", "L3"]);
export const VisibilitySchema = z.enum(["people", "topic", "root", "any"]);
export type Sensitivity = z.infer<typeof SensitivitySchema>;
export type Visibility = z.infer<typeof VisibilitySchema>;
export const sensitivityRank = (level: Sensitivity) => ({ L1: 1, L2: 2, L3: 3 })[level];
/** Unknown material defaults to private, highly sensitive knowledge. */
export const DisclosureFields = { sensitivity: SensitivitySchema.default("L3"), visibility: VisibilitySchema.default("people") };
export interface MaterialDisclosure { sensitivity?: Sensitivity; visibility?: Visibility }

/** @spec Input classification is a producer hint; absence stays unclassified until the Agent evaluates the content.
 * @link docs/personal/disclosure.md
 */
export const InputClassificationFields = { sensitivity: SensitivitySchema.optional(), visibility: VisibilitySchema.optional() };
export const inputClassification = ({ sensitivity, visibility }: MaterialDisclosure): MaterialDisclosure => ({
  ...(sensitivity === undefined ? {} : { sensitivity }), ...(visibility === undefined ? {} : { visibility }),
});
/** @spec Ordinary repository, PR/MR, requirement and environment facts are open collaboration material.
 * @why Producer defaults guide Note classification; credentials and unrelated personal privacy still require separate restricted Notes.
 * @link docs/personal/disclosure.md
 */
export const workInputClassification = (policy: MaterialDisclosure): Required<MaterialDisclosure> => ({
  sensitivity: policy.sensitivity ?? "L1", visibility: policy.visibility ?? "any",
});
