import { isDeepStrictEqual } from "node:util";
import type { ConnectorClient, PluginContext, PullRequestObservation, Resource } from "@compforge/aide-plugin";
import { digest, INPUT_TYPE } from "../../chief-model.ts";
import { bindSourceInput, type SourceInput } from "../input.ts";
import { SOURCES } from "../definition.ts";
import type { ForgeWatch } from "./config.ts";
import { FORGE_SOURCE_TYPE } from "./definition.ts";
export { FORGE_SOURCE_TYPE } from "./definition.ts";

import { fingerprint, keyOf, upgradeCheckpoint, type Tracked, type ForgeSourceStatus } from "./state.ts";
export type { ForgeSourceStatus } from "./state.ts";

type Context = Pick<PluginContext, "resources" | "logger">;
type Source = Resource<ForgeWatch, ForgeSourceStatus>;
const iso = (n: number) => new Date(n).toISOString();

/**
 * @spec A frozen observation and Input are durable before its baseline advances. Repeated transitions keep separate occurrence IDs.
 * @spec The repocli cursor advances only after all frozen PullRequest facts have been consumed; platform discovery belongs to the reader.
 * @link docs/connector/forge.md
 * @case tests/forge-source.test.ts
 */
class ForgeObservation {
  constructor(private context: Context, private resource: Source, private connectors: ConnectorClient, private now: string) {}
  private get tracked() { return this.resource.status.tracked ?? {}; }
  private async save(patch: Partial<ForgeSourceStatus>) {
    const latest = await this.context.resources.get<ForgeWatch, ForgeSourceStatus>({ ...FORGE_SOURCE_TYPE, ...this.resource.metadata });
    if (!latest || latest.metadata.uid !== this.resource.metadata.uid || latest.metadata.deletionTimestamp || !isDeepStrictEqual(latest.spec, this.resource.spec)) throw new Error("Forge Source changed during observation");
    this.resource = await this.context.resources.patchStatus(latest, patch);
  }
  private async deliver() {
    const plan = this.resource.status.pending;
    if (!plan) return;
    if (!await this.context.resources.get({ ...INPUT_TYPE, namespace: "v1", name: plan.name })) {
      await bindSourceInput(SOURCES.forges, this.resource, this.context.resources)(plan.name, plan.spec);
    }
    await this.save({ tracked: { ...this.tracked, [plan.key]: plan.entry }, pending: null });
    this.context.logger.info("Forge change admitted as Input", { attributes: { watchId: this.resource.spec.id, inputId: plan.name, forge: plan.entry.snapshot.repository.forge.name, path: plan.entry.snapshot.repository.path, number: plan.entry.snapshot.number, state: plan.entry.snapshot.state } });
  }
  private async observe(snapshot: PullRequestObservation) {
    const identity = { repository: snapshot.repository, number: snapshot.number };
    const key = keyOf(identity), previous = this.tracked[key];
    const observedFingerprint = fingerprint(snapshot);
    if (previous?.fingerprint === observedFingerprint) return;
    const entry: Tracked = { snapshot, fingerprint: observedFingerprint, ...(snapshot.state !== "open" ? { terminalAt: previous?.terminalAt ?? this.now } : {}) };
    const sequence = (this.resource.status.sequence ?? 0) + 1;
    const name = digest([this.resource.metadata.uid, sequence]);
    const change = previous ? `${previous.snapshot.state} → ${snapshot.state}` : `首次观察：${snapshot.state}`;
    const review = previous && (previous.snapshot.reviewActivityKey !== snapshot.reviewActivityKey || previous.snapshot.reviewThreads !== snapshot.reviewThreads)
      ? "\n评审线程有变化；完整内容可按需查询。" : "";
    const revision = previous?.snapshot.headSha !== snapshot.headSha ? `
revision：${previous?.snapshot.headSha ?? "未知"} → ${snapshot.headSha ?? "未知"}` : "";
    const spec: SourceInput = { topicKey: `forge:${key}`, topicName: `${identity.repository.path} #${identity.number}`.slice(0, 80), relation: "observed", attention: "deferred",
      text: `PR/MR ${identity.repository.forge.name}/${identity.repository.path} #${identity.number}：${snapshot.title}
${change}${revision}${review}
评审线程：${snapshot.reviewThreads}；代码冲突：${snapshot.conflictState}；合并条件：${snapshot.mergeReadiness}
${snapshot.url}`.slice(0, 32_000),
      observation: { kind: previous ? "forge.changed" : "forge.discovered", pullRequest: snapshot,
        ...(previous ? { previous: previous.snapshot } : {}), authorScope: this.resource.spec.author } };
    await this.save({ sequence, pending: { name, key, spec, entry } });
    await this.deliver();
  }
  private async read() {
    if (this.resource.status.batch) return;
    if (!this.resource.status.since && !this.resource.status.cursor) {
      await this.save({ since: iso(Date.parse(this.now) - this.resource.spec.initialLookbackMs) });
    }
    const result = await this.connectors.forges.readPullRequests(this.resource.spec.forge, {
      author: this.resource.spec.author, cursor: this.resource.status.cursor, since: this.resource.status.since,
      tracked: [...Object.values(this.tracked).filter(entry => entry.snapshot.state === "open").map(entry => entry.snapshot),
        ...(this.resource.status.seed ?? [])],
    });
    // Freeze facts and the proposed cursor before any Input is admitted.
    await this.save({ batch: { result, offset: 0 } });
  }
  private async consume() {
    let batch = this.resource.status.batch!;
    while (batch.offset < batch.result.items.length) {
      await this.observe(batch.result.items[batch.offset]!);
      batch = { ...batch, offset: batch.offset + 1 };
      await this.save({ batch });
    }
    const { result } = batch;
    const consumed = new Set(result.items.map(keyOf));
    const remaining = (this.resource.status.seed ?? []).filter(key => !consumed.has(keyOf(key)));
    await this.save({ cursor: result.cursor, readPending: result.pending, batch: null,
      // A partial batch cannot discharge other legacy references, including failed terminal reads.
      seed: remaining.length ? remaining : null, error: result.errors.join("; ") || null });
    if (result.errors.length) throw new Error(result.errors.join("; "));
  }
  async run() {
    const upgraded = upgradeCheckpoint(this.resource.status);
    if (upgraded) {
      await this.save(upgraded);
      this.context.logger.info("Forge checkpoint upgraded to shared PR facts", { attributes: { watchId: this.resource.spec.id } });
    }
    await this.deliver();
    await this.read();
    await this.consume();
    const cutoff = Date.parse(this.now) - this.resource.spec.initialLookbackMs;
    const tracked = Object.fromEntries(Object.entries(this.tracked).filter(([, entry]) => !entry.terminalAt || Date.parse(entry.terminalAt) >= cutoff));
    await this.save({ tracked, lastObservedAt: this.now, error: null });
    this.context.logger.info("Forge observation completed", { attributes: { watchId: this.resource.spec.id, forge: this.resource.spec.forge,
      author: this.resource.spec.author, tracked: Object.keys(tracked).length, readPending: Boolean(this.resource.status.readPending) } });
  }
}
export async function observeForge(context: Context, resource: Source, connectors: ConnectorClient, now = new Date().toISOString()) {
  await new ForgeObservation(context, resource, connectors, now).run();
}
export function registerForgeSources(context: PluginContext) {
  const watches = (context.instance.config.forgeSources ?? []) as ForgeWatch[];
  if (!watches.length) return;
  context.controllers.register<ForgeWatch, ForgeSourceStatus>({ resourceType: FORGE_SOURCE_TYPE,
    sources: [{ type: "resource", sourceId: "configured-forges", async start(source) {
      for (const watch of watches) await source.emit({ name: digest(watch), spec: watch });
    } }],
    async reconcile(execution, resource) {
      if (resource.metadata.deletionTimestamp || !watches.some(w => isDeepStrictEqual(w, resource.spec))) return;
      try { await observeForge(context, resource, execution.verbs.connectors({ timeoutMs: 60_000 })); }
      catch (error) {
        context.logger.error("Forge observation failed; checkpoint retained", { error, attributes: { watchId: resource.spec.id, forge: resource.spec.forge } });
        const current = await context.resources.get<ForgeWatch, ForgeSourceStatus>({ ...FORGE_SOURCE_TYPE, ...resource.metadata });
        if (current && current.metadata.uid === resource.metadata.uid) await context.resources.patchStatus(current, { error: error instanceof Error ? error.message : String(error) });
      }
      const latest = await context.resources.get<ForgeWatch, ForgeSourceStatus>({ ...FORGE_SOURCE_TYPE, ...resource.metadata });
      const pending = latest?.status.batch || latest?.status.pending || latest?.status.readPending || !latest?.status.cursor;
      return { requeueAfterMs: pending && !latest?.status.error ? 1000 : resource.spec.intervalMs };
    },
  });
}
