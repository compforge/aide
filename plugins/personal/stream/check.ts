import type { StreamReader } from "@compforge/aide-plugin";
import { streamEvidence } from "../../../src/stream/agent.ts";
export interface DisclosureEvidence { text: string; materials: Array<{ id: string; text: string }> }
export type SemanticCheck = (evidence: DisclosureEvidence) => Promise<{ allowed: boolean; reason: string }>;
/** Content-aware verification is separate from recipient policy and delivery orchestration. */
export async function checkMail(reader: StreamReader, materials: DisclosureEvidence["materials"], check?: SemanticCheck): Promise<string> {
  if (!check) return "Content/reference verification is unavailable";
  try {
    const evidence = { text: streamEvidence(reader), materials };
    if (JSON.stringify(evidence).length > 100_000) return "Evidence exceeds the bounded disclosure review budget";
    const verdict = await check(evidence);
    return verdict.allowed ? "" : verdict.reason || "Content is not supported by the disclosed materials";
  } catch { return "Content/reference verification failed; original message was not sent"; }
}
