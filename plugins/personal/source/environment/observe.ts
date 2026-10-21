import { bindSourceInput } from "@compforge/aide-plugin";
import { SOURCES } from "../definition.ts";
import type { ConnectorClient, EnvironmentSnapshot, PluginContext, Resource, WorkloadSnapshot } from "@compforge/aide-plugin";
import { type EnvironmentSourceSpec } from "./config.ts";
import { INPUT_TYPE, digest, type InputSpec, type InputStatus } from "../../chief-model.ts";

export const ENVIRONMENT_SOURCE_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "EnvironmentSource" } as const;
export interface EnvironmentSourceStatus {
  baseline?: EnvironmentSnapshot;
  sequence?: number;
  lastObservedAt?: string;
  error?: string | null;
}
interface WorkloadChange { before?: WorkloadSnapshot; after?: WorkloadSnapshot }
interface WorkloadEvent {
  type: "workload.changed";
  environment: string;
  namespace: string;
  observedAt: string;
  previousObservedAt: string;
  changes: WorkloadChange[];
}
/** The producer describes observed facts; Chief owns decisions about their significance. */
function describeWorkloadChanges(event: WorkloadEvent): string {
  const lines = event.changes.slice(0, 20).map(({ before, after }) => {
    const workload = after ?? before!;
    const identity = `${workload.kind} ${workload.name}`;
    if (!before) return `- ${identity}：新增`;
    if (!after) return `- ${identity}：移除`;
    const fields = [
      before.generation !== after.generation ? `generation ${before.generation} → ${after.generation}` : "",
      JSON.stringify(before.images) !== JSON.stringify(after.images) ? `镜像 ${before.images.map((i) => i.image).join(", ")} → ${after.images.map((i) => i.image).join(", ")}` : "",
      before.ready !== after.ready || before.desired !== after.desired ? `就绪副本 ${before.ready}/${before.desired} → ${after.ready}/${after.desired}` : "",
    ].filter(Boolean);
    return `- ${identity}：${fields.length ? fields.join("；") : "Pod 或运行状态变化"}`;
  });
  if (event.changes.length > lines.length) lines.push(`其余 ${event.changes.length - lines.length} 项变化见完整观察数据。`);
  return `${event.environment} / ${event.namespace}：${event.changes.length} 项 Workload 变化。\n\n${lines.join("\n")}`.slice(0, 32_000);
}

const identity = (workload: WorkloadSnapshot) => `${workload.kind}/${workload.name}`;

export function workloadChanges(before: EnvironmentSnapshot, after: EnvironmentSnapshot): WorkloadChange[] {
  const previous = new Map(before.workloads.map((item) => [identity(item), item]));
  const current = new Map(after.workloads.map((item) => [identity(item), item]));
  return [...new Set([...previous.keys(), ...current.keys()])].sort().flatMap((key) => {
    const before = previous.get(key); const after = current.get(key);
    return digest(before ?? null) === digest(after ?? null) ? [] : [{ ...(before ? { before } : {}), ...(after ? { after } : {}) }];
  });
}

/**
 * @spec Initial observation is silent. Inputs are durable before the baseline advances.
 * @why A sequence identifies an occurrence, so A→B→A→B is not suppressed as a duplicate.
 * @case tests/environment-source.test.ts
 * @link docs/connector/README.md
 */
export async function observeEnvironment(context: Pick<PluginContext, "resources" | "logger">,
  resource: Resource<EnvironmentSourceSpec, EnvironmentSourceStatus>, connectors: ConnectorClient): Promise<void> {
  const sequence = (resource.status.sequence ?? 0) + 1;
  const name = digest([resource.metadata.uid, sequence]);
  const existing = await context.resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "aide-system", name });
  if (existing && resource.status.baseline) {
    // Resume the exact emitted transition before sampling again, even if the live environment has moved on.
    const event = existing.spec.observation as unknown as WorkloadEvent;
    const workloads = new Map(resource.status.baseline.workloads.map((item) => [identity(item), item]));
    for (const change of event.changes) {
      if (change.after) workloads.set(identity(change.after), change.after);
      else if (change.before) workloads.delete(identity(change.before));
    }
    await context.resources.patchStatus(resource, { sequence, error: null, lastObservedAt: event.observedAt,
      baseline: { ...resource.status.baseline, observedAt: event.observedAt, workloads: [...workloads.values()] } });
    context.logger.info("Environment observation recovered", { attributes: { watchId: resource.spec.environment, inputId: name, sequence } });
    return;
  }
  const snapshot = await connectors.environments.workloads(resource.spec.environment, resource.spec.namespace);
  const baseline = resource.status.baseline;
  const changes = baseline ? workloadChanges(baseline, snapshot) : [];
  if (changes.length) {
    const event: WorkloadEvent = { type: "workload.changed", environment: snapshot.environment, namespace: snapshot.namespace,
      observedAt: snapshot.observedAt, previousObservedAt: baseline!.observedAt, changes };
    const submit = bindSourceInput(SOURCES.environments, resource, context.resources);
    await submit(name, { text: describeWorkloadChanges(event), observation: { ...event } });
  }
  await context.resources.patchStatus(resource, { baseline: snapshot, sequence: changes.length ? sequence : resource.status.sequence ?? 0,
    lastObservedAt: snapshot.observedAt, error: null });
  context.logger.info(baseline ? "Environment observation completed" : "Environment baseline established", {
    attributes: { watchId: resource.spec.environment, environment: snapshot.environment, namespace: snapshot.namespace,
      workloads: snapshot.workloads.length, changed: changes.length, ...(changes.length ? { inputId: name } : {}) },
  });
}

export function registerEnvironmentSources(context: PluginContext): void {
  const watches = (context.instance.config.environmentSources ?? []) as EnvironmentSourceSpec[];
  if (!watches.length) return;
  context.controllers.register<EnvironmentSourceSpec, EnvironmentSourceStatus>({ resourceType: ENVIRONMENT_SOURCE_TYPE,
    sources: [{ type: "resource", sourceId: "configured-environments", async start(source) {
      for (const watch of watches) await source.emit({ name: digest(watch), spec: watch });
    } }],
    async reconcile(execution, resource) {
      if (resource.metadata.deletionTimestamp) return;
      const configured = watches.find((watch) => watch.environment === resource.spec.environment && watch.namespace === resource.spec.namespace);
      if (!configured || digest(configured) !== digest(resource.spec)) return;
      try { await observeEnvironment(context, resource, execution.verbs.connectors({ timeoutMs: 30_000 })); }
      catch (error) {
        context.logger.error("Environment observation failed; baseline retained", { error,
          attributes: { watchId: resource.spec.environment, environment: resource.spec.environment, namespace: resource.spec.namespace ?? "" } });
        const current = await context.resources.get<EnvironmentSourceSpec, EnvironmentSourceStatus>({ ...ENVIRONMENT_SOURCE_TYPE, ...resource.metadata });
        if (current) await context.resources.patchStatus(current, { error: error instanceof Error ? error.message : String(error) });
      }
      return { requeueAfterMs: resource.spec.intervalMs };
    },
  });
}
