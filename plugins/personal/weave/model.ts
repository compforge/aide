import type { Resource } from "@compforge/aide-plugin";
import { z } from "zod";
import type { LoopStatus } from "../loop.ts";
export const WEAVE_TYPE = { apiVersion: "aide.dev/v1alpha2", kind: "Weave" } as const;
export const WEAVE_NAME = "global";
const topicVersion = z.object({ uid: z.string(), version: z.string() }).strict();
export const GroupSchema = z.object({
  topics: z.array(topicVersion).min(1).max(8), parent: topicVersion.optional(),
  name: z.string().min(1).max(200).optional(), summary: z.string().min(1).max(16000).optional(),
}).strict().superRefine((group, ctx) => {
  if (!group.parent && (group.topics.length < 2 || !group.name || !group.summary))
    ctx.addIssue({ code: "custom", message: "A new parent requires 2-8 Topics, name and summary" });
  if (group.parent && (group.name || group.summary))
    ctx.addIssue({ code: "custom", message: "An existing parent retains its own name and understanding" });
});
export interface WeaveStatus extends LoopStatus {
  nextAt?: string;
  lastRunAt?: string;
}
export type WeaveResource = Resource<Record<string, never>, WeaveStatus>;
