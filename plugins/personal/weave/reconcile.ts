import { createHash } from "node:crypto";
import { understandingVersion } from "../topic/tree.ts";
import type { PluginContext, Watch } from "@compforge/aide-plugin";
import { WEAVE_TYPE, WEAVE_NAME, type WeaveResource } from "./model.ts";
import { weavePolicy } from "./config.ts";
import { applyGroup } from "./service.ts";
import { runInput, finalizeExecution } from "../loop.ts";
import { TOPIC_TYPE, type TopicSpec, type TopicStatus } from "../topic/model.ts";
const request = () => [{ name: WEAVE_NAME, namespace: "v1" as const }];
const watch: Watch = { resourceType: WEAVE_TYPE, handler: { create: async () => [], delete: async () => [],
  update: async ({ oldObject, newObject }) => JSON.stringify((oldObject as WeaveResource).status.plan) !== JSON.stringify((newObject as WeaveResource).status.plan) ? request() : [] } };
export function registerWeave(context: PluginContext) {
  const policy = weavePolicy(context.instance.config.weave);
  if (!policy.enabled) return;
  context.controllers.register<Record<string, never>, WeaveResource["status"]>({
    resourceType: WEAVE_TYPE, maxConcurrency: 1, watches: [watch, { resourceType: TOPIC_TYPE, handler: { create: async () => request(), delete: async () => request(),
      update: async ({ oldObject, newObject }) => {
        const a = oldObject as import("../topic/model.ts").TopicResource, b = newObject as import("../topic/model.ts").TopicResource;
        return a.spec.parentRef?.uid !== b.spec.parentRef?.uid || understandingVersion(a) !== understandingVersion(b) ? request() : [];
      } } }],
    sources: [{ type: "resource", sourceId: "global", async start(source) { await source.emit({ name: WEAVE_NAME, spec: {} }); } }],
    async reconcile(execution, initial) {
      if (initial.metadata.deletionTimestamp) return;
      if (initial.status.execution) { await finalizeExecution(context, initial, initial.status.execution.id); return { requeueAfterMs: 1 }; }
      if (initial.status.plan) {
        const outcome = await applyGroup(context.resources, initial);
        (outcome === "waiting" ? context.logger.debug : context.logger.info)("Weave handoff reconciled", { attributes: { planId: initial.status.plan.id, newParentId: initial.status.plan.id, childUids: initial.status.plan.topics.map(t => t.uid), outcome } });
        return { requeueAfterMs: outcome === "waiting" ? 1000 : policy.intervalMs };
      }
      const roots = (await context.resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE)).filter(t => !t.metadata.deletionTimestamp && !t.spec.parentRef && !t.spec.default && !t.status.weaveLock);
      const fingerprint = createHash("sha256").update(JSON.stringify(roots.map(t => [t.metadata.uid, t.spec.name, understandingVersion(t)]).sort())).digest("hex");
      const changed = fingerprint !== initial.status.fingerprint;
      const pressured = roots.length >= policy.rootThreshold && changed;
      const remaining = Date.parse(initial.status.nextAt ?? "") - Date.now();
      const cooldown = Date.parse(initial.status.lastRunAt ?? "") + Math.min(30_000, policy.intervalMs) - Date.now();
      if (remaining > 0 && (!pressured || cooldown > 0)) return { requeueAfterMs: pressured ? Math.min(remaining, cooldown) : remaining };
      const cursor = (initial.status.cursor ?? 0) % Math.max(1, roots.length);
      const scanned = changed ? 0 : initial.status.scanned ?? 0;
      const shouldRun = roots.length >= 2 && scanned < roots.length;
      const owner = await context.resources.patchStatus(initial, { nextAt: new Date(Date.now() + policy.intervalMs).toISOString(),
        fingerprint, scanned: shouldRun ? scanned + policy.batchSize : scanned, cursor: shouldRun ? cursor + policy.batchSize : cursor,
        ...(shouldRun ? { lastRunAt: new Date().toISOString() } : {}) });
      if (shouldRun) {
        const completed = await runInput(context, execution, owner, "weave",
        `Review at most ${policy.batchSize} root Topics starting at offset ${cursor}, oldest quiet first. Read one candidate batch, then search for relevant peers. Group only a meaningful shared subject. At most one group this run. No user replies or work creation.`);
        if (!completed) {
          const latest = await context.resources.get<Record<string, never>, WeaveResource["status"]>({ ...WEAVE_TYPE, ...owner.metadata });
          if (latest) await context.resources.patchStatus(latest, { cursor, scanned });
          context.logger.warn("Weave analysis did not finish; batch retained for retry", { attributes: { cursor, roots: roots.length } });
        }
      }
      return { requeueAfterMs: 1 };
    },
  });
}
