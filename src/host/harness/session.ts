import type { AgentStatus, ResourceClient } from "@compforge/aide-plugin";
import type { ExecutionScope } from "../../protocol/verbs.ts";
import type { HarnessSessionMeta } from "../execution-context.ts";

/** @spec Only the owning resource holds the native recovery reference. UID and CAS prevent attaching to a replacement resource.
 * @link docs/harness/README.md
 */
export class ResourceSession {
  constructor(private readonly resources: ResourceClient, private readonly scope: ExecutionScope,
    private readonly key: string, private readonly targetId: string, private readonly harness: string) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key) || ["constructor", "prototype"].includes(key)) throw new Error("Invalid Harness session status key");
  }
  private async resource() {
    const ref = this.scope.resourceRef;
    if (!ref?.uid) throw new Error("Native session requires an owning resource UID");
    const resource = await this.resources.get<unknown, Record<string, unknown>>(ref);
    if (!resource || resource.metadata.uid !== ref.uid || resource.metadata.deletionTimestamp) throw new Error("Native session owner is missing or deleted");
    return resource;
  }
  async read(): Promise<HarnessSessionMeta | undefined> {
    const resource = await this.resource();
    const agent = resource.status[this.key] as AgentStatus | undefined;
    if (!agent?.session) return;
    // Target changes select a different native context. The Harness owns workspace recovery checks.
    if (agent.targetId !== this.targetId || agent.harness !== this.harness) return;
    return { harness: agent.harness, harnessSessionId: agent.session.id, resumeState: agent.session.resume };
  }
  async write(session: HarnessSessionMeta): Promise<void> {
    if (!session.harnessSessionId) throw new Error("Harness did not publish a durable session reference");
    const value: AgentStatus = { targetId: this.targetId, harness: this.harness,
      session: { id: session.harnessSessionId, ...(session.resumeState ? { resume: session.resumeState } : {}) } };
    for (let attempt = 0; ; attempt++) {
      const resource = await this.resource();
      try { await this.resources.patchStatus(resource, { [this.key]: value }); return; }
      catch (error) { if (attempt >= 8 || !String(error).includes("version conflict")) throw error; }
    }
  }
}
