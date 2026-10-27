import { isDeepStrictEqual } from "node:util";
import type { ConnectorClient, PluginContext, PullRequestSnapshot, Resource } from "@compforge/aide-plugin";
import { digest, INPUT_TYPE } from "../../chief-model.ts";
import { bindSourceInput, type SourceInput } from "../input.ts";
import { configureSource } from "../configure.ts";
import { SOURCES } from "../definition.ts";
import { pullRequestSpec, pullRequestSourceName, type PullRequestSourceSpec, type PullRequestWatch } from "./config.ts";
import { REPOSITORY_SOURCE_TYPE } from "../repository/definition.ts";
import type { RepositorySourceSpec } from "../repository/config.ts";
import type { RepositorySourceStatus } from "../repository/state.ts";
import { PULL_REQUEST_SOURCE_TYPE } from "./definition.ts";
export { PULL_REQUEST_SOURCE_TYPE } from "./definition.ts";

import { fingerprint, keyOf, nextPullRequestPollDelay, type Tracked, type PullRequestSourceStatus } from "./state.ts";
export type { PullRequestSourceStatus } from "./state.ts";

type Context = Pick<PluginContext, "resources" | "logger">;
type Source = Resource<PullRequestSourceSpec, PullRequestSourceStatus>;
const iso = (n: number) => new Date(n).toISOString();

/**
 * @spec A frozen observation and Input are durable before its baseline advances. Repeated transitions keep separate occurrence IDs.
 * @spec The repocli cursor advances only after all frozen PullRequest facts have been consumed; platform discovery belongs to the reader.
 * @link docs/connector/forge.md
 * @case tests/pull-request-source.test.ts
 */
class PullRequestObservation {
  constructor(private context: Context, private resource: Source, private connectors: ConnectorClient, private now: string) {}
  private get tracked() { return this.resource.status.snapshot?.value ?? {}; }
  private async save(patch: Partial<PullRequestSourceStatus>) {
    const latest = await this.context.resources.get<PullRequestSourceSpec, PullRequestSourceStatus>({ ...PULL_REQUEST_SOURCE_TYPE, ...this.resource.metadata });
    if (!latest || latest.metadata.uid !== this.resource.metadata.uid || latest.metadata.deletionTimestamp || !isDeepStrictEqual(latest.spec, this.resource.spec)) throw new Error("PullRequest Source changed during observation");
    this.resource = await this.context.resources.patchStatus(latest, patch);
  }
  private async deliver() {
    const plan = this.resource.status.pending;
    if (!plan) return;
    if (!await this.context.resources.get({ ...INPUT_TYPE, namespace: "v1", name: plan.name })) {
      await bindSourceInput(SOURCES.pullRequests, this.resource, this.context.resources)(plan.name, plan.spec);
    }
    await this.save({ snapshot: { value: { ...this.tracked, [plan.key]: plan.entry }, observedAt: this.now }, pending: null });
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
      await this.save({ snapshot: { value: { ...this.tracked, [key]: entry }, observedAt: this.now } });
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
      scope: this.resource.spec.repository
        ? { kind: "repository", repository: this.resource.spec.repository, author: this.resource.spec.author }
        : { kind: "account", author: this.resource.spec.author }, cursor: this.resource.status.cursor ?? undefined,
      initialSince: this.resource.status.initialSince,
      tracked: Object.values(this.tracked).filter(entry => entry.snapshot.state === "open").map(entry => entry.snapshot),
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
    await this.save({ ...(result.cursor ? { cursor: result.cursor } : {}), scanPending: result.pending, scanComplete: result.complete,
      batch: null, issues: result.issues, error: null });
    if (result.issues.length) this.context.logger.warn("Forge scan retained coverage gaps", { attributes: {
      watchId: this.resource.spec.id, forge: this.resource.spec.forge, pending: result.pending, complete: result.complete,
      issues: result.issues.map(issue => ({ stage: issue.stage, kind: issue.kind, message: issue.message,
        key: issue.key ? keyOf(issue.key) : null, retryAfterMs: issue.retryAfterMs ?? null,
        updatedAfter: issue.window?.updatedAfter ?? null, updatedBefore: issue.window?.updatedBefore ?? null })),
    } });
  }

  async run(active: boolean) {
    if (!active) {
      await this.deliver();
      if (this.resource.status.batch) await this.consume();
      if (!this.resource.status.retiredAt) {
        await this.save({ retiredAt: this.now, error: null });
        this.context.logger.info("PullRequest Source retired after draining frozen observations", { attributes: { watchId: this.resource.spec.id, forge: this.resource.spec.forge, path: this.resource.spec.repository?.path ?? null } });
      }
      return;
    }
    const cutoff = Date.parse(this.now) - this.resource.spec.initialLookbackMs;
    const inputSince = iso(Math.max(Date.parse(this.resource.status.inputSince ?? iso(cutoff)), cutoff));
    await this.save({ initialSince: this.resource.status.initialSince ?? inputSince, inputSince, retiredAt: null });
    await this.deliver();
    await this.read();
    await this.consume();
    const tracked = Object.fromEntries(Object.entries(this.tracked).filter(([, entry]) => !entry.terminalAt || Date.parse(entry.terminalAt) >= cutoff));
    await this.save({ snapshot: { value: tracked, observedAt: this.now }, lastObservedAt: this.now, error: null });
    this.context.logger.info("PullRequest observation completed", { attributes: { watchId: this.resource.spec.id, forge: this.resource.spec.forge,
      author: this.resource.spec.author, tracked: Object.keys(tracked).length, scanPending: Boolean(this.resource.status.scanPending), scanComplete: this.resource.status.scanComplete ?? false, issues: this.resource.status.issues?.length ?? 0 } });
  }
}
export async function observePullRequests(context: Context, resource: Source, connectors: ConnectorClient, now = new Date().toISOString(), active = true) {
  await new PullRequestObservation(context, resource, connectors, now).run(active);
}

/** A missing repository only retires its observer after a completed inventory refresh. */
export async function pullRequestSourceActive(context: Pick<PluginContext, "resources">, resource: Source,
  watches: readonly PullRequestWatch[], repositories: readonly RepositorySourceSpec[], revisions: Readonly<Record<string, string>> = {}): Promise<boolean> {
  const watch = watches.find(w => w.id === resource.spec.id);
  if (!watch) return false;
  if ("forge" in watch) return isDeepStrictEqual(pullRequestSpec(watch, undefined, undefined, revisions[watch.forge]), resource.spec);
  const reference = resource.spec.repositorySource;
  if (!reference || !resource.spec.repository) return false;
  const parent = await context.resources.get<RepositorySourceSpec, RepositorySourceStatus>({ ...REPOSITORY_SOURCE_TYPE,
    namespace: resource.metadata.namespace, ...reference });
  if (!parent || parent.spec.id !== watch.repositories || parent.metadata.deletionTimestamp || parent.status.retiredAt || !repositories.some(w => isDeepStrictEqual(w, parent.spec))) return false;
  return isDeepStrictEqual(pullRequestSpec(watch, parent, resource.spec.repository), resource.spec)
    && Boolean(parent.status.snapshot?.value.some(repo => repo.path === resource.spec.repository!.path && repo.forge.name === resource.spec.forge));
}

export function registerPullRequestSources(context: PluginContext) {
  const watches = (context.instance.config.pullRequestSources ?? []) as PullRequestWatch[];
  const revisions = (context.instance.config.forgeConnectionRevisions ?? {}) as Record<string, string>;
  const repositories = ((context.instance.config.repositorySources ?? []) as Omit<RepositorySourceSpec, "connectionRevision">[])
    .map(w => ({ ...w, connectionRevision: revisions[w.forge] ?? "" }));
  const requests = async (uid: string) => (await context.resources.list<PullRequestSourceSpec, PullRequestSourceStatus>(PULL_REQUEST_SOURCE_TYPE,
    { matchIndex: { name: "repositorySource", value: uid } })).map(r => ({ name: r.metadata.name, namespace: r.metadata.namespace }));
  context.controllers.register<PullRequestSourceSpec, PullRequestSourceStatus>({ resourceType: PULL_REQUEST_SOURCE_TYPE, maxConcurrency: 2,
    sources: [{ type: "resource", sourceId: "configured-pull-requests", async start(source) {
      for (const watch of watches) if ("forge" in watch) {
        const spec = pullRequestSpec(watch, undefined, undefined, revisions[watch.forge]);
        const name = pullRequestSourceName(spec);
        await configureSource(context.resources, PULL_REQUEST_SOURCE_TYPE, name, spec);
        await source.emit({ name, spec });
      }
    } }],
    watches: [{ resourceType: REPOSITORY_SOURCE_TYPE, handler: {
      create: async () => [],
      delete: async event => requests(event.object.metadata.uid),
      update: async ({ oldObject, newObject }) => {
        const before = oldObject as Resource<RepositorySourceSpec, RepositorySourceStatus>;
        const after = newObject as Resource<RepositorySourceSpec, RepositorySourceStatus>;
        return isDeepStrictEqual(before.status.snapshot, after.status.snapshot) && before.status.retiredAt === after.status.retiredAt
          ? [] : requests(after.metadata.uid);
      },
    } }],
    async reconcile(execution, resource) {
      if (resource.metadata.deletionTimestamp) return;
      let failed = false;
      try {
        const active = await pullRequestSourceActive(context, resource, watches, repositories, revisions);
        await observePullRequests(context, resource, execution.verbs.connectors({ timeoutMs: 90_000 }), new Date().toISOString(), active);
        if (!active) return;
      } catch (error) {
        failed = true;
        context.logger.error("PullRequest observation failed; checkpoint retained", { error, attributes: { watchId: resource.spec.id, forge: resource.spec.forge, path: resource.spec.repository?.path ?? null } });
        const current = await context.resources.get<PullRequestSourceSpec, PullRequestSourceStatus>({ ...PULL_REQUEST_SOURCE_TYPE, ...resource.metadata });
        if (current && current.metadata.uid === resource.metadata.uid) await context.resources.patchStatus(current, { error: error instanceof Error ? error.message : String(error) });
      }
      const latest = await context.resources.get<PullRequestSourceSpec, PullRequestSourceStatus>({ ...PULL_REQUEST_SOURCE_TYPE, ...resource.metadata });
      return { requeueAfterMs: failed ? resource.spec.intervalMs : nextPullRequestPollDelay(latest?.status ?? {}, resource.spec.intervalMs) };
    },
  });
}
