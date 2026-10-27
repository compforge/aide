import { isDeepStrictEqual } from "node:util";
import type { ConnectorClient, PluginContext, Resource } from "@compforge/aide-plugin";
import { digest } from "../../chief-model.ts";
import { pullRequestSpec, pullRequestSourceName, type PullRequestWatch } from "../pull-request/config.ts";
import { PULL_REQUEST_SOURCE_TYPE } from "../pull-request/definition.ts";
import { repositorySourceName, type RepositorySourceSpec } from "./config.ts";
import { configureSource } from "../configure.ts";
import { REPOSITORY_SOURCE_TYPE } from "./definition.ts";
import type { RepositorySourceStatus } from "./state.ts";

type Context = Pick<PluginContext, "resources" | "logger">;
type Source = Resource<RepositorySourceSpec, RepositorySourceStatus>;
const HANDOFF_BATCH_SIZE = 20;

/**
 * @spec Only a complete, issue-free enumeration replaces the cached inventory. An expired inventory remains usable during refresh.
 * @spec Child observers are created idempotently before handoff progress advances; no external reads occur while handoff is pending.
 * @why Cache freshness and durable downstream progress have independent lifecycles.
 * @link docs/connector/forge.md
 * @case tests/repository-source.test.ts
 */
class RepositoryObservation {
  constructor(private context: Context, private resource: Source, private connectors: ConnectorClient,
    private policies: readonly PullRequestWatch[], private now: string) {}
  private async save(patch: Partial<RepositorySourceStatus>) {
    const latest = await this.context.resources.get<RepositorySourceSpec, RepositorySourceStatus>({ ...REPOSITORY_SOURCE_TYPE, ...this.resource.metadata });
    if (!latest || latest.metadata.uid !== this.resource.metadata.uid || latest.metadata.deletionTimestamp || !isDeepStrictEqual(latest.spec, this.resource.spec)) throw new Error("Repository Source changed during observation");
    this.resource = await this.context.resources.patchStatus(latest, patch);
  }
  private async handoff() {
    const policies = this.policies.filter(w => "repositories" in w && w.repositories === this.resource.spec.id);
    const policyKey = digest(policies);
    const desired = (this.resource.status.snapshot?.value ?? []).flatMap(repo => policies.map(w => pullRequestSpec(w, this.resource, repo)));
    let offset = this.resource.status.handoff?.policyKey === policyKey ? this.resource.status.handoff.offset : 0;
    const end = Math.min(offset + HANDOFF_BATCH_SIZE, desired.length);
    while (offset < end) {
      const spec = desired[offset]!;
      const name = pullRequestSourceName(spec);
      if (await configureSource(this.context.resources, PULL_REQUEST_SOURCE_TYPE, name, spec, this.resource.metadata.namespace)) {
        this.context.logger.info("Repository discovered; PullRequest Source created", { attributes: { repositorySource: this.resource.spec.id, watchId: spec.id, forge: spec.forge, path: spec.repository!.path } });
      }
      offset++;
      await this.save({ handoff: { offset, policyKey } });
    }
    if (offset < desired.length) return false;
    await this.save({ handoff: null });
    return true;
  }
  async run(): Promise<number> {
    if (this.resource.status.retiredAt) await this.save({ retiredAt: null });
    const handedOff = Boolean(this.resource.status.handoff);
    if (handedOff && !await this.handoff()) return 1000;
    const now = Date.parse(this.now);
    if (this.resource.status.retryAt && now < Date.parse(this.resource.status.retryAt)) return Date.parse(this.resource.status.retryAt) - now;
    const freshUntil = this.resource.status.snapshot ? Date.parse(this.resource.status.snapshot.observedAt) + this.resource.spec.refreshIntervalMs : 0;
    if (!this.resource.status.refresh && now < freshUntil) {
      // Startup may add a PR policy while the inventory is still fresh.
      return handedOff || await this.handoff() ? freshUntil - now : 1000;
    }
    if (!this.resource.status.refresh) await this.save({ refresh: { startedAt: this.now, items: [] }, retiredAt: null });
    const refresh = this.resource.status.refresh!;
    const page = await this.connectors.forges.listRepositories(this.resource.spec.forge, { pageSize: 50, cursor: refresh.cursor });
    if (page.issues?.length) {
      const delay = Math.max(this.resource.spec.retryIntervalMs, ...page.issues.map(i => i.retryAfterMs ?? 0));
      await this.save({ refresh: null, issues: page.issues, retryAt: new Date(now + delay).toISOString(), error: "Repository inventory coverage incomplete" });
      this.context.logger.warn("Repository refresh incomplete; cached inventory retained", { attributes: { watchId: this.resource.spec.id, forge: this.resource.spec.forge, issues: page.issues.map(i => ({ kind: i.kind, message: i.message, retryAfterMs: i.retryAfterMs ?? null })), retryAfterMs: delay } });
      return delay;
    }
    if (page.nextCursor !== undefined && page.nextCursor === refresh.cursor) throw new Error("Repository pagination did not advance");
    const items = new Map(refresh.items.map(repo => [repo.path, repo]));
    for (const repo of page.items) {
      if (repo.forge.name !== this.resource.spec.forge) throw new Error("Repository page belongs to another Forge");
      items.set(repo.path, repo);
    }
    if (page.nextCursor !== undefined) {
      await this.save({ refresh: { ...refresh, items: [...items.values()], cursor: page.nextCursor }, issues: [], error: null, retryAt: null });
      return 1000;
    }
    // Publish the complete inventory and its handoff together. Existing observers see membership only after this commit.
    await this.save({ snapshot: { value: [...items.values()], observedAt: this.now }, refresh: null,
      handoff: { offset: 0, policyKey: "" }, issues: [], error: null, retryAt: null });
    this.context.logger.info("Repository inventory refreshed", { attributes: { watchId: this.resource.spec.id, forge: this.resource.spec.forge,
      repositories: items.size, startedAt: refresh.startedAt, observedAt: this.now } });
    return await this.handoff() ? this.resource.spec.refreshIntervalMs : 1000;
  }
}
export async function observeRepositories(context: Context, resource: Source, connectors: ConnectorClient,
  policies: readonly PullRequestWatch[], now = new Date().toISOString()): Promise<number> {
  return new RepositoryObservation(context, resource, connectors, policies, now).run();
}

export function registerRepositorySources(context: PluginContext) {
  const revisions = (context.instance.config.forgeConnectionRevisions ?? {}) as Record<string, string>;
  const watches = ((context.instance.config.repositorySources ?? []) as Omit<RepositorySourceSpec, "connectionRevision">[])
    .map(w => ({ ...w, connectionRevision: revisions[w.forge] ?? "" }));
  const policies = (context.instance.config.pullRequestSources ?? []) as PullRequestWatch[];
  context.controllers.register<RepositorySourceSpec, RepositorySourceStatus>({ resourceType: REPOSITORY_SOURCE_TYPE, maxConcurrency: 1,
    sources: [{ type: "resource", sourceId: "configured-repositories", async start(source) {
      for (const watch of watches) {
        const name = repositorySourceName(watch);
        await configureSource(context.resources, REPOSITORY_SOURCE_TYPE, name, watch);
        await source.emit({ name, spec: watch });
      }
    } }],
    async reconcile(execution, resource) {
      if (resource.metadata.deletionTimestamp) return;
      if (!watches.some(w => isDeepStrictEqual(w, resource.spec))) {
        if (!resource.status.retiredAt) await context.resources.patchStatus(resource, { retiredAt: new Date().toISOString() });
        return;
      }
      try {
        return { requeueAfterMs: await observeRepositories(context, resource, execution.verbs.connectors({ timeoutMs: 30_000 }), policies) };
      } catch (error) {
        context.logger.error("Repository refresh failed; cached inventory and progress retained", { error, attributes: {
          watchId: resource.spec.id, forge: resource.spec.forge, snapshotAt: resource.status.snapshot?.observedAt ?? null } });
        const current = await context.resources.get<RepositorySourceSpec, RepositorySourceStatus>({ ...REPOSITORY_SOURCE_TYPE, ...resource.metadata });
        if (current && current.metadata.uid === resource.metadata.uid) await context.resources.patchStatus(current, {
          error: error instanceof Error ? error.message : String(error), retryAt: new Date(Date.now() + resource.spec.retryIntervalMs).toISOString() });
        return { requeueAfterMs: resource.spec.retryIntervalMs };
      }
    },
  });
}
