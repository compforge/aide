import { z } from "zod";

export const SensitivitySchema = z.enum(["L1", "L2", "L3"]);
export const VisibilitySchema = z.enum(["people", "topic", "root", "any"]);
export type Sensitivity = z.infer<typeof SensitivitySchema>;
export type Visibility = z.infer<typeof VisibilitySchema>;
export const sensitivityRank = (level: Sensitivity) => ({ L1: 1, L2: 2, L3: 3 })[level];
/** Unknown material defaults to private, highly sensitive knowledge. */
export const DisclosureFields = { sensitivity: SensitivitySchema.default("L3"), visibility: VisibilitySchema.default("people") };
export interface MaterialDisclosure { sensitivity?: Sensitivity; visibility?: Visibility }
