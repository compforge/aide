import type { PluginContext, Resource } from "@compforge/aide-plugin";
import type { ConnectorClient } from "@compforge/aide-plugin";
import { parseWatches, type Watch } from "./source-config.ts";
import { INPUT_TYPE, digest, type InputSpec, type InputStatus } from "./chief-model.ts";

export const SOURCE_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "RequirementSource" } as const;
interface SourceStatus { seen?: Record<string, string>; lastObservedAt?: string; error?: string | null }

/** Polls are scheduled by the runtime. Persist the inbox before advancing its discovery watermark. */
export async function observeRequirements(context: Pick<PluginContext, "resources" | "logger">, resource: Resource<Watch, SourceStatus>, connectors: ConnectorClient): Promise<void> {
  const summaries = await connectors.requirements.list(resource.spec.source);
  const seen = { ...resource.status.seen };
  let discovered = 0;
  for (const requirement of summaries) {
    const identity = JSON.stringify([requirement.source, requirement.category, requirement.id]);
    const fingerprint = digest(requirement);
    if (seen[identity] === fingerprint) continue;
    if (requirement.state === "completed" || requirement.state === "closed") { seen[identity] = fingerprint; continue; }
    const name = digest([resource.metadata.uid, identity, fingerprint]);
    if (!await context.resources.get({ ...INPUT_TYPE, namespace: "aide-system", name })) {
      await context.resources.create<InputSpec, InputStatus>(INPUT_TYPE, { name, spec: {
        conversationId: resource.spec.conversationId, origin: "source",
        text: "发现分配给用户的需求或其变化。读取详情与相关工作，判断是否需要通知、询问或推进已有委托。",
        observation: { watch: resource.spec, requirement },
      } });
      discovered++;
    }
    seen[identity] = fingerprint;
  }
  await context.resources.patchStatus(resource, { seen, lastObservedAt: new Date().toISOString(), error: null });
  context.logger.info("Requirement discovery completed", { attributes: { watchId: resource.spec.id, observed: summaries.length, discovered } });
}

export function registerSources(context: PluginContext): void {
  const watches = parseWatches(context.instance.config);
  if (!watches.length) return;
  const connectors = context.connectors;
  context.controllers.register<Watch, SourceStatus>({ resourceType: SOURCE_TYPE,
    sources: [{ type: "resource", sourceId: "configured-requirements", async start(source) {
      for (const watch of watches) await source.emit({ name: digest(watch), spec: watch });
    } }],
    async reconcile(_execution, resource) {
      if (resource.metadata.deletionTimestamp) return;
      const configured = watches.find((item) => item.id === resource.spec.id);
      // Config changes create a fresh observation scope; obsolete resources stop polling.
      if (!configured || digest(configured) !== digest(resource.spec)) return;
      try { await observeRequirements(context, resource, connectors); }
      catch (error) {
        context.logger.error("Requirement discovery failed; watermark retained", { error, attributes: { watchId: resource.spec.id } });
        const current = await context.resources.get<Watch, SourceStatus>({ ...SOURCE_TYPE, ...resource.metadata });
        if (current) await context.resources.patchStatus(current, { error: error instanceof Error ? error.message : String(error) });
      }
      return { requeueAfterMs: resource.spec.intervalMs };
    },
  });
}
