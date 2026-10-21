import { bindSourceInput } from "@compforge/aide-plugin";
import { isDeepStrictEqual } from "node:util";
import { SOURCES } from "../definition.ts";
import type { PluginContext, Resource } from "@compforge/aide-plugin";
import type { ConnectorClient } from "@compforge/aide-plugin";
import { type Watch } from "./config.ts";
import { INPUT_TYPE, digest } from "../../chief-model.ts";

import { SOURCE_TYPE } from "./definition.ts";
export { SOURCE_TYPE } from "./definition.ts";
interface SourceStatus { pendingInputIds?: string[]; seen?: Record<string, string>; lastObservedAt?: string; error?: string | null }

/** Polls are scheduled by the runtime. Persist the inbox before advancing its discovery watermark. */
export async function observeRequirements(context: Pick<PluginContext, "resources" | "logger">, resource: Resource<Watch, SourceStatus>, connectors: ConnectorClient): Promise<void> {
  const summaries = await connectors.requirements.list(resource.spec.source, { assigneeUserKeys: resource.spec.userKeys });
  const submit = bindSourceInput(SOURCES.requirements, resource, context.resources);
  const seen = { ...resource.status.seen };
  let discovered = 0;
  for (const requirement of summaries) {
    const identity = JSON.stringify([requirement.source, requirement.category, requirement.id]);
    const fingerprint = digest(requirement);
    if (seen[identity] === fingerprint) continue;
    if (requirement.state === "completed" || requirement.state === "closed") { seen[identity] = fingerprint; continue; }
    const name = digest([resource.metadata.uid, identity, fingerprint]);
    if (!await context.resources.get({ ...INPUT_TYPE, namespace: "aide-system", name })) {
      resource = await context.resources.patchStatus(resource, { pendingInputIds: [...resource.status.pendingInputIds ?? [], name] });
      await submit(name, {
        sessionId: resource.spec.sessionId,
        relation: "observed",
        text: `需求 ${requirement.id}：${requirement.title}\n状态：${requirement.state}`,
        observation: { watch: resource.spec, requirement },
      });
      discovered++;
    }
    seen[identity] = fingerprint;
  }
  await context.resources.patchStatus(resource, { seen, pendingInputIds: [], lastObservedAt: new Date().toISOString(), error: null });
  context.logger.info("Requirement discovery completed", { attributes: { watchId: resource.spec.id, observed: summaries.length, discovered } });
}
export function registerSources(context: PluginContext): void {
  const watches = (context.instance.config.watches ?? []) as Watch[];
  if (!watches.length) return;
  context.controllers.register<Watch, SourceStatus>({ resourceType: SOURCE_TYPE,
    sources: [{ type: "resource", sourceId: "configured-requirements", async start(source) {
      for (const watch of watches) await source.emit({ name: digest(watch), spec: watch });
    } }],
    async reconcile(execution, resource) {
      if (resource.metadata.deletionTimestamp) return;
      const configured = watches.find((item) => item.id === resource.spec.id);
      // Config changes create a fresh observation scope; obsolete resources stop polling.
      if (!configured || !isDeepStrictEqual(configured, resource.spec)) return;
      try { await observeRequirements(context, resource, execution.verbs.connectors({ timeoutMs: 30_000 })); }
      catch (error) {
        context.logger.error("Requirement discovery failed; watermark retained", { error, attributes: { watchId: resource.spec.id } });
        const current = await context.resources.get<Watch, SourceStatus>({ ...SOURCE_TYPE, ...resource.metadata });
        if (current) await context.resources.patchStatus(current, { error: error instanceof Error ? error.message : String(error) });
      }
      return { requeueAfterMs: resource.spec.intervalMs };
    },
  });
}
