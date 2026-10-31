import type { AgentStatus } from "@compforge/aide-plugin";
import type { SessionView } from "@compforge/agent-observation";

/** Reads native evidence on demand; never creates a session or restores an agent. */
export type ReadSession = (agent: AgentStatus & { sessionId: string }) => Promise<SessionView>;
