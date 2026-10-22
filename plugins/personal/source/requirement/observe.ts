import { bindSourceInput, type ConnectorClient, type PluginContext, type RequirementAccount, type RequirementIdentity, type RequirementSummary, type Resource, type SourceInput } from "@compforge/aide-plugin";
import { isDeepStrictEqual } from "node:util";
import { requirementAddress } from "../../../../connectors/requirements/address.ts";
import { Persons } from "../../person/service.ts";
import { LOCAL_ME, type Me } from "../../person/model.ts";
import { observeRequirementPeople } from "../../person/requirements.ts";
import { relationToPerson } from "../../person/relation.ts";
import { SOURCES } from "../definition.ts";
import { type Watch } from "./config.ts";
import { INPUT_TYPE, digest } from "../../chief-model.ts";
import { SOURCE_TYPE } from "./definition.ts";
import type { RequirementSourceStatus, TrackedRequirement } from "./state.ts";
export { SOURCE_TYPE } from "./definition.ts";
export type { RequirementSourceStatus } from "./state.ts";
type Context = Pick<PluginContext, "resources" | "logger">;
type Source = Resource<Watch, RequirementSourceStatus>;
const keyOf = (item: RequirementIdentity) => JSON.stringify([item.category, item.id]);
const identityOf = ({ source, category, id }: RequirementIdentity): RequirementIdentity => ({ source, category, id });
const finished = (item: RequirementSummary) => item.state === "completed" || item.state === "closed";
const iso = (n: number) => new Date(n).toISOString();

/**
 * @spec Freeze each page and Input plan before publishing. Only persisted Inputs advance observation state.
 * @spec A monotonic observation sequence preserves repeated A-B-A-B transitions; retries reuse the frozen plan.
 * @spec Comments have their own bounded time windows; work-item updated_at is not a comment watermark.
 * @link docs/connector/requirements.md
 */
class RequirementObservation {
  private readonly persons: Persons;
  private account!: RequirementAccount;
  private me: Me = { identities: [] };
  constructor(private readonly context: Context, private resource: Source, private readonly connectors: ConnectorClient, private readonly now: string) {
    this.persons = new Persons(context.resources, { identities: [LOCAL_ME] });
  }
  private get tracked() { return this.resource.status.tracked ?? {}; }
  private async save(patch: Partial<RequirementSourceStatus>) {
    const latest = await this.context.resources.get<Watch, RequirementSourceStatus>({ ...SOURCE_TYPE, ...this.resource.metadata });
    if (!latest || latest.metadata.deletionTimestamp || latest.metadata.uid !== this.resource.metadata.uid || !isDeepStrictEqual(latest.spec, this.resource.spec)) throw new Error("Requirement Source changed during observation");
    this.resource = await this.context.resources.patchStatus(latest, patch);
  }
  private async setEntry(key: string, entry?: TrackedRequirement) {
    const tracked = { ...this.tracked };
    if (entry) tracked[key] = entry; else delete tracked[key];
    await this.save({ tracked });
  }
  private async deliver() {
    const plan = this.resource.status.pending;
    if (!plan) return;
    if (!await this.context.resources.get({ ...INPUT_TYPE, namespace: "aide-system", name: plan.name })) {
      await bindSourceInput(SOURCES.requirements, this.resource, this.context.resources)(plan.name, plan.spec);
    }
    await this.save({ tracked: { ...this.tracked, [plan.key]: plan.entry }, pending: null });
  }
  private async publish(key: string, entry: TrackedRequirement, spec: SourceInput) {
    const sequence = (this.resource.status.sequence ?? 0) + 1;
    const name = digest([this.resource.metadata.uid, this.account.scope, sequence]);
    await this.save({ sequence, pending: { name, spec: { ...spec, text: spec.text.slice(0, 32_000) || "需求评论（无文本）" }, key, entry } });
    await this.deliver();
  }
  private relation(author?: string, recipients: readonly string[] = []) {
    const identity = (id: string) => ({ provider: this.account.provider, scope: this.account.scope, id });
    const observer = this.me.identities.find((i) => i.provider === this.account.provider && i.scope === this.account.scope && this.resource.spec.userKeys.includes(i.id));
    return relationToPerson(this.me, { ...(author ? { author: identity(author) } : {}), recipients: recipients.map(identity), observer });
  }
  private base(identity: RequirementIdentity): SourceInput {
    return { sessionId: this.resource.spec.sessionId, source: requirementAddress(identity, this.account.scope), text: "", attention: "deferred" };
  }
  private async snapshot(item: RequirementSummary & { description?: string }) {
    const key = keyOf(item), previous = this.tracked[key];
    if (!previous && finished(item)) return;
    const assigned = item.assignees?.some((p) => this.resource.spec.userKeys.includes(p.key));
    if (!previous && assigned === false) return;
    await observeRequirementPeople(this.persons, this.account, item.assignees ?? []);
    const fingerprint = digest([item.title, item.state, item.assignees, item.description]);
    const entry: TrackedRequirement = { ...(previous ?? { identity: identityOf(item), baselineAt: this.now, commentsThrough: this.now, recent: {} }),
      fingerprint, retiring: finished(item) || assigned === false };
    if (previous?.fingerprint === fingerprint && previous.retiring === entry.retiring) return;
    const relation = this.relation();
    await this.publish(key, entry, { ...this.base(item), ...(relation ? { relation } : {}), text: `需求 ${item.id}：${item.title}\n状态：${item.state}`,
      observation: { kind: previous ? "requirement.changed" : "requirement.discovered", requirement: item, ...(previous ? { previousFingerprint: previous.fingerprint } : {}) } });
  }
  private async discover() {
    let scan = this.resource.status.scan;
    if (!scan) {
      scan = { ...(this.resource.status.scannedThrough ? { start: iso(Date.parse(this.resource.status.scannedThrough) - 60_000) } : {}), end: this.now };
      await this.save({ scan });
    }
    if (!scan.page) {
      try {
        const page = await this.connectors.requirements.list(this.resource.spec.source, { assigneeUserKeys: this.resource.spec.userKeys,
          updatedAfter: scan.start, updatedBefore: scan.end, cursor: scan.cursor });
        scan = { ...scan, page };
      } catch (error) {
        // Provider query sessions can expire across restarts. Replay the fixed window without advancing it.
        if (scan.cursor) await this.save({ scan: { ...(scan.start ? { start: scan.start } : {}), end: scan.end } });
        throw error;
      }
      await this.save({ scan });
    }
    for (const item of scan.page!.items) {
      if (!this.tracked[keyOf(item)] && !finished(item)) await this.snapshot(await this.connectors.requirements.get(item));
    }
    if (scan.page!.nextCursor) {
      if (scan.page!.nextCursor === scan.cursor) throw new Error("Requirement pagination did not advance");
      await this.save({ scan: { ...(scan.start ? { start: scan.start } : {}), end: scan.end, cursor: scan.page!.nextCursor } });
    } else await this.save({ scannedThrough: scan.end, scan: null });
  }
  private async comments(key: string) {
    let entry = this.tracked[key]!;
    if (!entry.window) {
      entry = { ...entry, window: { start: iso(Date.parse(entry.commentsThrough) - 60_000), end: this.now } };
      await this.setEntry(key, entry);
    }
    let window = entry.window!;
    if (!window.page) {
      const page = await this.connectors.requirements.comments(entry.identity, { start: window.start, end: window.end, cursor: window.cursor });
      window = { ...window, page }; entry = { ...entry, window }; await this.setEntry(key, entry);
    }
    for (const comment of window.page!.items) {
      entry = this.tracked[key]!;
      // First discovery establishes a baseline; overlap only deduplicates later observations.
      if (Date.parse(comment.createdAt) < Date.parse(window.start) || Date.parse(comment.createdAt) > Date.parse(window.end)) continue;
      const fingerprint = digest([comment.text, comment.updatedAt]);
      if (entry.recent[comment.id]?.fingerprint === fingerprint) continue;
      const next = { ...entry, recent: { ...entry.recent, [comment.id]: { fingerprint, at: comment.createdAt } } };
      if (comment.ownOutput || Date.parse(comment.createdAt) < Date.parse(entry.baselineAt)) {
        await this.setEntry(key, next); continue;
      }
      const people = await observeRequirementPeople(this.persons, this.account, [...(comment.author ? [comment.author] : []), ...comment.mentions ?? []]);
      const relation = this.relation(comment.author?.key, comment.mentions?.map((p) => p.key));
      await this.publish(key, next, { ...this.base(entry.identity), text: comment.text,
        ...(comment.author ? { sender: people.get(comment.author.key) } : {}), ...(relation ? { relation } : {}),
        observation: { kind: "requirement.comment", requirement: entry.identity, comment } });
    }
    entry = this.tracked[key]!;
    if (window.page!.nextCursor) {
      if (window.page!.nextCursor === window.cursor) throw new Error("Comment pagination did not advance");
      await this.setEntry(key, { ...entry, window: { start: window.start, end: window.end, cursor: window.page!.nextCursor } });
    } else if (entry.retiring) await this.setEntry(key);
    else {
      const { window: _, ...rest } = entry;
      await this.setEntry(key, { ...rest, commentsThrough: window.end,
        recent: Object.fromEntries(Object.entries(entry.recent).filter(([, value]) => Date.parse(value.at) >= Date.parse(window.end) - 60_000)) });
    }
  }
  async run() {
    await this.deliver();
    this.account = await this.connectors.requirements.identity(this.resource.spec.source);
    const person = await this.persons.me();
    this.me = { identities: person?.spec.identities ?? [] };
    if (this.resource.status.scope !== this.account.scope) await this.save({ scope: this.account.scope, tracked: {}, scan: null, scannedThrough: null, pendingInputIds: [], seen: {} });
    // Existing work remains observable after completion or reassignment removes it from discovery queries.
    const existing = Object.keys(this.tracked);
    const failures: string[] = [];
    try { await this.discover(); } catch (error) { if (this.resource.status.pending) throw error; failures.push(String(error)); }
    for (const key of [...new Set([...existing, ...Object.keys(this.tracked)])]) {
      try {
        const entry = this.tracked[key]; if (!entry) continue;
        if (existing.includes(key) && !entry.retiring && !entry.window) await this.snapshot(await this.connectors.requirements.get(entry.identity));
        await this.comments(key);
      } catch (error) { failures.push(`${key}: ${String(error)}`); }
      if (this.resource.status.pending) break;
    }
    if (failures.length) throw new Error(`Requirement observation incomplete: ${failures.join("; ")}`);
    await this.save({ lastObservedAt: this.now, error: null });
    this.context.logger.info("Requirement observation completed", { attributes: { watchId: this.resource.spec.id, tracked: Object.keys(this.tracked).length, scanPending: Boolean(this.resource.status.scan) } });
  }
}
export async function observeRequirements(context: Context, resource: Source, connectors: ConnectorClient, now = new Date().toISOString()): Promise<void> {
  await new RequirementObservation(context, resource, connectors, now).run();
}
export function registerSources(context: PluginContext): void {
  const watches = (context.instance.config.watches ?? []) as Watch[];
  if (!watches.length) return;
  context.controllers.register<Watch, RequirementSourceStatus>({ resourceType: SOURCE_TYPE,
    sources: [{ type: "resource", sourceId: "configured-requirements", async start(source) {
      for (const watch of watches) await source.emit({ name: digest(watch), spec: watch });
    } }],
    async reconcile(execution, resource) {
      if (resource.metadata.deletionTimestamp) return;
      const configured = watches.find((item) => item.id === resource.spec.id);
      if (!configured || !isDeepStrictEqual(configured, resource.spec)) return;
      try { await observeRequirements(context, resource, execution.verbs.connectors({ timeoutMs: 60_000 })); }
      catch (error) {
        context.logger.error("Requirement observation failed; checkpoint retained", { error, attributes: { watchId: resource.spec.id } });
        const current = await context.resources.get<Watch, RequirementSourceStatus>({ ...SOURCE_TYPE, ...resource.metadata });
        if (current) await context.resources.patchStatus(current, { error: error instanceof Error ? error.message : String(error) });
      }
      const latest = await context.resources.get<Watch, RequirementSourceStatus>({ ...SOURCE_TYPE, ...resource.metadata });
      const unfinished = latest?.status.scan || latest?.status.pending || Object.values(latest?.status.tracked ?? {}).some((e) => e.window);
      return { requeueAfterMs: unfinished && !latest?.status.error ? 1000 : resource.spec.intervalMs };
    },
  });
}
