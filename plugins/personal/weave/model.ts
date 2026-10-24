import type { Resource } from "@compforge/aide-plugin";
import { z } from "zod";
import type { LoopStatus } from "../loop.ts";
export const WEAVE_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Weave" } as const;
export const WEAVE_NAME = "global";
export const GroupSchema = z.object({
  topics: z.array(z.object({ uid: z.string(), version: z.string() }).strict()).min(2).max(8),
  name: z.string().min(1).max(200), summary: z.string().min(1).max(16000),
}).strict();
export interface WeaveStatus extends LoopStatus {
  nextAt?: string;
  lastRunAt?: string;
  fingerprint?: string;
  scanned?: number;
  cursor?: number;
  plan?: (z.infer<typeof GroupSchema> & { id: string; at: string; moving?: boolean }) | null;
}
export type WeaveResource = Resource<Record<string, never>, WeaveStatus>;
