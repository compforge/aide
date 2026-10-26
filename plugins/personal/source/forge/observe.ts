import { isDeepStrictEqual } from "node:util";
import type { ConnectorClient, PluginContext, PullRequest, PullRequestDiscoveryQuery, PullRequestPage, Resource } from "@compforge/aide-plugin";
import { digest, INPUT_TYPE } from "../../chief-model.ts";
import { bindSourceInput, type SourceInput } from "../input.ts";
import { SOURCES } from "../definition.ts";
import type { ForgeWatch } from "./config.ts";
import { FORGE_SOURCE_TYPE } from "./definition.ts";
export { FORGE_SOURCE_TYPE } from "./definition.ts";

interface Tracked { snapshot: PullRequest; fingerprint: string; terminalAt?: string }
interface Scan { query: PullRequestDiscoveryQuery; page?: PullRequestPage; offset: number }
export interface ForgeSourceStatus {
  initialized?: boolean; sequence?: number; tracked?: Record<string, Tracked>;
  scan?: Scan | null; scannedThrough?: string;
  pending?: { name: string; key: string; spec: SourceInput; entry: Tracked } | null;
  refreshAfter?: string | null; refreshedAt?: string; lastObservedAt?: string; error?: string | null;
}
type Context = Pick<PluginContext, "resources" | "logger">;
type Source = Resource<ForgeWatch, ForgeSourceStatus>;
const keyOf = (pr: PullRequest["identity"]) => JSON.stringify([pr.forge, pr.path, pr.number]);
const iso = (n: number) => new Date(n).toISOString();
const BATCH_SIZE = 5;

/**
 * @spec A frozen observation and Input are durable before its baseline advances. Repeated transitions keep separate occurrence IDs.
 * @spec Tracked open PRs are read directly, so merging out of an open inventory cannot hide their terminal transition.
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
    this.context.logger.info("Forge change admitted as Input", { attributes: { watchId: this.resource.spec.id, inputId: plan.name, ...plan.entry.snapshot.identity, lifecycle: plan.entry.snapshot.lifecycle } });
  }
  private async observe(identity: PullRequest["identity"]) {
    const snapshot = await this.connectors.forges.get(identity);
    if (keyOf(snapshot.identity) !== keyOf(identity)) throw new Error("Forge returned a different PR identity");
    const key = keyOf(identity), previous = this.tracked[key];
    // Polling metadata and target-branch movement alone do not describe a new authored change.
    const { observedAt: _, updatedAt: __, baseSha: ___, ...facts } = snapshot;
    const fingerprint = digest(facts);
    if (previous?.fingerprint === fingerprint) return;
    const entry: Tracked = { snapshot, fingerprint, ...(snapshot.lifecycle !== "open" ? { terminalAt: previous?.terminalAt ?? this.now } : {}) };
    const sequence = (this.resource.status.sequence ?? 0) + 1;
    const name = digest([this.resource.metadata.uid, sequence]);
    const change = previous ? `${previous.snapshot.lifecycle} → ${snapshot.lifecycle}` : `首次观察：${snapshot.lifecycle}`;
    const review = previous && (previous.snapshot.reviewActivityKey !== snapshot.reviewActivityKey || previous.snapshot.reviewThreads !== snapshot.reviewThreads)
      ? "\n评审线程有变化；完整内容可按需查询。" : "";
    const revision = previous?.snapshot.headSha !== snapshot.headSha ? `
revision：${previous?.snapshot.headSha ?? "未知"} → ${snapshot.headSha ?? "未知"}` : "";
    const spec: SourceInput = { topicKey: `forge:${key}`, topicName: `${identity.path} #${identity.number}`.slice(0, 80), relation: "observed", attention: "deferred",
      text: `PR/MR ${identity.forge}/${identity.path} #${identity.number}：${snapshot.title}
${change}${revision}${review}
评审线程：${snapshot.reviewThreads}；合并条件：${snapshot.mergeability}
${snapshot.url}`.slice(0, 32_000),
      observation: { kind: previous ? "forge.changed" : "forge.discovered", pullRequest: snapshot,
        ...(previous ? { previous: previous.snapshot } : {}), authorScope: this.resource.spec.author } };
    await this.save({ sequence, pending: { name, key, spec, entry } });
    await this.deliver();
  }
  private async discover() {
    let scan = this.resource.status.scan;
    if (!scan) {
      const { initialized, scannedThrough } = this.resource.status;
      scan = { query: { author: this.resource.spec.author, state: initialized ? "all" : "open", updatedBefore: this.now,
        ...(initialized ? { updatedAfter: scannedThrough ? iso(Date.parse(scannedThrough) - 60_000) : iso(Date.parse(this.now) - this.resource.spec.initialLookbackMs) } : {}) }, offset: 0 };
      await this.save({ scan });
    }
    if (!scan.page) {
      const page = await this.connectors.forges.discover(this.resource.spec.forge, scan.query);
      if (page.nextCursor && page.nextCursor === scan.query.cursor) throw new Error("Forge discovery pagination did not advance");
      if (page.items.some(i => i.forge !== this.resource.spec.forge)) throw new Error("Forge discovery returned a foreign identity");
      scan = { ...scan, page }; await this.save({ scan });
    }
    const end = Math.min(scan.page!.items.length, scan.offset + BATCH_SIZE);
    while (scan.offset < end) {
      await this.observe(scan.page!.items[scan.offset]!);
      scan = { ...scan, offset: scan.offset + 1 }; await this.save({ scan });
    }
    if (scan.offset < scan.page!.items.length) return;
    if (scan.page!.nextCursor) await this.save({ scan: { query: { ...scan.query, cursor: scan.page!.nextCursor }, offset: 0 } });
    else if (scan.query.state === "open") await this.save({ initialized: true, scan: null });
    else await this.save({ scannedThrough: scan.query.updatedBefore, scan: null });
  }
  private async refresh() {
    const status = this.resource.status;
    if (!status.refreshAfter && status.refreshedAt && Date.parse(this.now) - Date.parse(status.refreshedAt) < this.resource.spec.intervalMs) return;
    const keys = Object.keys(this.tracked).filter(key => this.tracked[key]!.snapshot.lifecycle === "open" && (!status.refreshAfter || key > status.refreshAfter)).sort();
    const batch = keys.slice(0, BATCH_SIZE);
    const errors: string[] = [];
    for (const key of batch) {
      try { await this.observe(this.tracked[key]!.snapshot.identity); }
      catch (error) { if (this.resource.status.pending) throw error; errors.push(`${key}: ${String(error)}`); }
      await this.save({ refreshAfter: key });
    }
    if (keys.length <= BATCH_SIZE) await this.save({ refreshAfter: null, refreshedAt: this.now });
    if (errors.length) throw new Error(errors.join("; "));
  }
  async run() {
    await this.deliver();
    const errors: string[] = [];
    try { await this.discover(); } catch (error) { if (this.resource.status.pending) throw error; errors.push(String(error)); }
    // Discovery failure must not prevent already-known PRs from reaching merged/closed.
    try { await this.refresh(); } catch (error) { errors.push(String(error)); }
    if (errors.length) throw new Error(`Forge observation incomplete: ${errors.join("; ")}`);
    const cutoff = Date.parse(this.now) - this.resource.spec.initialLookbackMs;
    const tracked = Object.fromEntries(Object.entries(this.tracked).filter(([, entry]) => !entry.terminalAt || Date.parse(entry.terminalAt) >= cutoff));
    await this.save({ tracked, lastObservedAt: this.now, error: null });
    this.context.logger.info("Forge observation completed", { attributes: { watchId: this.resource.spec.id, forge: this.resource.spec.forge,
      author: this.resource.spec.author, tracked: Object.keys(tracked).length, scanPending: Boolean(this.resource.status.scan) } });
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
      const pending = latest?.status.scan || latest?.status.pending || latest?.status.refreshAfter || !latest?.status.scannedThrough;
      return { requeueAfterMs: pending && !latest?.status.error ? 1000 : resource.spec.intervalMs };
    },
  });
}
