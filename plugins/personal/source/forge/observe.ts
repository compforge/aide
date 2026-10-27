import { isDeepStrictEqual } from "node:util";
import type { ConnectorClient, PluginContext, PullRequestSnapshot, Resource } from "@compforge/aide-plugin";
import { digest, INPUT_TYPE } from "../../chief-model.ts";
import { bindSourceInput, type SourceInput } from "../input.ts";
import { SOURCES } from "../definition.ts";
import type { ForgeWatch } from "./config.ts";
import { FORGE_SOURCE_TYPE } from "./definition.ts";
export { FORGE_SOURCE_TYPE } from "./definition.ts";

import { fingerprint, keyOf, upgradeCheckpoint, nextForgePollDelay, type Tracked, type ForgeSourceStatus } from "./state.ts";
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
    this.context.logger.info("Forge change admitted as Input", { attributes: { watchId: this.resource.spec.id, inputId: plan.name, forge: plan.entry.snapshot.repository.forge.name, path: plan.entry.snapshot.repository.path, number: plan.entry.snapshot.number, state: plan.entry.snapshot.state ?? "unknown" } });
  }
  private async observe(snapshot: PullRequestSnapshot, inputSince: string) {
    const identity = { repository: snapshot.repository, number: snapshot.number };
    const key = keyOf(identity), previous = this.tracked[key];
    const observedFingerprint = fingerprint(snapshot);
    if (previous?.fingerprint === observedFingerprint) return;
    const entry: Tracked = { snapshot, fingerprint: observedFingerprint, ...(snapshot.state !== "open" ? { terminalAt: previous?.terminalAt ?? this.now } : {}) };
    const timely = previous !== undefined || (snapshot.mergedAt !== undefined && Date.parse(snapshot.mergedAt) >= Date.parse(inputSince));
    if (snapshot.state !== "merged" || previous?.snapshot.state === "merged" || !timely) {
      await this.save({ tracked: { ...this.tracked, [key]: entry } });
      return;
    }
    const sequence = (this.resource.status.sequence ?? 0) + 1;
    const name = digest([this.resource.metadata.uid, sequence]);
    const change = previous ? `${previous.snapshot.state ?? "未知"} → merged` : "首次观察到已合并";
    const spec: SourceInput = { topicKey: `forge:${key}`, topicName: `${identity.repository.path} #${identity.number}`.slice(0, 80), relation: "observed", attention: "deferred",
      text: `PR/MR ${identity.repository.forge.name}/${identity.repository.path} #${identity.number}：${snapshot.title ?? ""}
${change}
revision：${snapshot.headSha ?? "未知"}
${snapshot.url ?? ""}`.slice(0, 32_000),
      observation: { kind: "forge.merged", pullRequest: snapshot,
        ...(previous ? { previous: previous.snapshot } : {}), authorScope: this.resource.spec.author } };
    await this.save({ sequence, pending: { name, key, spec, entry } });
    await this.deliver();
  }
  private async read() {
    if (this.resource.status.batch) return;
    const result = await this.connectors.forges.scanPullRequests(this.resource.spec.forge, {
      scope: { kind: "account", author: this.resource.spec.author }, cursor: this.resource.status.cursor ?? undefined,
      initialSince: this.resource.status.initialSince,
      tracked: [...Object.values(this.tracked).filter(entry => entry.snapshot.state === "open").map(entry => entry.snapshot),
        ...(this.resource.status.seed ?? [])],
    });
    // Freeze facts and the proposed cursor before any Input is admitted.
    await this.save({ batch: { result, offset: 0, inputSince: this.resource.status.inputSince! } });
  }
  private async consume() {
    let batch = this.resource.status.batch!;
    while (batch.offset < batch.result.items.length) {
      await this.observe(batch.result.items[batch.offset]!, batch.inputSince);
      batch = { ...batch, offset: batch.offset + 1 };
      await this.save({ batch });
    }
    const { result } = batch;
    const consumed = new Set(result.items.map(keyOf));
    const remaining = (this.resource.status.seed ?? []).filter(key => !consumed.has(keyOf(key)));
    await this.save({ ...(result.cursor ? { cursor: result.cursor } : {}), scanPending: result.pending, scanComplete: result.complete,
      batch: null, seed: remaining.length ? remaining : null, issues: result.issues, error: null });
    if (result.issues.length) this.context.logger.warn("Forge scan retained coverage gaps", { attributes: {
      watchId: this.resource.spec.id, forge: this.resource.spec.forge, pending: result.pending, complete: result.complete,
      issues: result.issues.map(issue => ({ stage: issue.stage, kind: issue.kind, message: issue.message,
        key: issue.key ? keyOf(issue.key) : null, retryAfterMs: issue.retryAfterMs ?? null,
        updatedAfter: issue.window?.updatedAfter ?? null, updatedBefore: issue.window?.updatedBefore ?? null })),
    } });
  }

  async run() {
    const upgraded = upgradeCheckpoint(this.resource.status, this.now, this.resource.spec.initialLookbackMs);
    if (upgraded) {
      await this.save(upgraded);
      this.context.logger.info("Forge checkpoint upgraded to independent snapshots and scan coverage", { attributes: { watchId: this.resource.spec.id } });
    }
    const inputSince = iso(Math.max(Date.parse(this.resource.status.inputSince!), Date.parse(this.now) - this.resource.spec.initialLookbackMs));
    await this.save({ inputSince });
    await this.deliver();
    await this.read();
    await this.consume();
    const cutoff = Date.parse(this.now) - this.resource.spec.initialLookbackMs;
    const tracked = Object.fromEntries(Object.entries(this.tracked).filter(([, entry]) => !entry.terminalAt || Date.parse(entry.terminalAt) >= cutoff));
    await this.save({ tracked, lastObservedAt: this.now, error: null });
    this.context.logger.info("Forge observation completed", { attributes: { watchId: this.resource.spec.id, forge: this.resource.spec.forge,
      author: this.resource.spec.author, tracked: Object.keys(tracked).length, scanPending: Boolean(this.resource.status.scanPending), scanComplete: this.resource.status.scanComplete ?? false, issues: this.resource.status.issues?.length ?? 0 } });
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
      try { await observeForge(context, resource, execution.verbs.connectors({ timeoutMs: 90_000 })); }
      catch (error) {
        context.logger.error("Forge observation failed; checkpoint retained", { error, attributes: { watchId: resource.spec.id, forge: resource.spec.forge } });
        const current = await context.resources.get<ForgeWatch, ForgeSourceStatus>({ ...FORGE_SOURCE_TYPE, ...resource.metadata });
        if (current && current.metadata.uid === resource.metadata.uid) await context.resources.patchStatus(current, { error: error instanceof Error ? error.message : String(error) });
      }
      const latest = await context.resources.get<ForgeWatch, ForgeSourceStatus>({ ...FORGE_SOURCE_TYPE, ...resource.metadata });
      return { requeueAfterMs: nextForgePollDelay(latest?.status ?? {}, resource.spec.intervalMs) };
    },
  });
}
