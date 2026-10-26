import { z } from "zod";
import { AgentStatusSchema } from "../session.ts";
import type { AgentStatus } from "@compforge/aide-plugin";

/** Native identity of the tool that committed a business fact; independent of the original admission. */
export const AgentCallSchema = z.object({
  agent: AgentStatusSchema.extend({ sessionId: z.string().min(1) }),
  executionId: z.string().min(1), toolCallId: z.string().min(1),
}).strict();
export type AgentCall = z.infer<typeof AgentCallSchema>;
export function agentCall(status: { agent?: AgentStatus; execution?: { id: string } | null }, toolCallId?: string): AgentCall | undefined {
  if (!toolCallId || !status.agent?.sessionId || !status.execution) return;
  return { agent: { harness: status.agent.harness, sessionId: status.agent.sessionId }, executionId: status.execution.id, toolCallId };
}
