import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { resourceAccess, type ResourceAccess } from "@compforge/harness-toolbox/kubernetes/resources";
import { parsePods } from "@compforge/harness-toolbox/kubernetes/pod";
import type { EnvironmentDefinition, EnvironmentSnapshot, WorkloadSnapshot } from "@compforge/aide-plugin";

const kinds = ["Deployment", "StatefulSet", "DaemonSet", "Pod"] as const;
const ResourceSchema = z.object({
  kind: z.enum([...kinds, "ReplicaSet"]),
  metadata: z.object({ name: z.string().min(1), namespace: z.string().min(1), uid: z.string().min(1),
    generation: z.number().optional(), deletionTimestamp: z.string().optional(),
    ownerReferences: z.array(z.object({ uid: z.string(), kind: z.string(), controller: z.boolean().optional() })).default([]) }),
  spec: z.object({ replicas: z.number().optional(), template: z.object({ spec: z.object({
    containers: z.array(z.object({ name: z.string(), image: z.string() })).default([]),
  }) }).optional() }).default({}),
  status: z.object({ readyReplicas: z.number().optional(), desiredNumberScheduled: z.number().optional(), numberReady: z.number().optional() }).default({}),
});
const ListSchema = z.object({ metadata: z.object({ continue: z.string().optional() }).optional(), items: z.array(z.unknown()) });
type KubeResource = z.infer<typeof ResourceSchema>;
const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

/** @spec Ownership follows controller UIDs, never Pod-name prefixes or Kubernetes Service names. */
export function workloadSnapshot(lists: readonly unknown[], environment: string, namespace: string): EnvironmentSnapshot {
  const raw = lists.flatMap((list) => {
    const parsed = ListSchema.parse(list);
    if (parsed.metadata?.continue) throw new Error("Incomplete Kubernetes list; baseline retained");
    return parsed.items;
  });
  const resources = raw.map((item) => ResourceSchema.parse(item));
  if (resources.some((item) => item.metadata.namespace !== namespace)) throw new Error("Kubernetes list contains a different namespace");
  const byUid = new Map(resources.map((item) => [item.metadata.uid, item]));
  const pods = parsePods(JSON.stringify({ items: raw.filter((_, i) => resources[i]!.kind === "Pod") }), namespace);
  const workloadPods = new Map<string, WorkloadSnapshot["pods"][number][]>();
  for (const pod of pods) {
    let owner: KubeResource | undefined = byUid.get(pod.uid!);
    const visited = new Set<string>();
    while (owner && (owner.kind === "Pod" || owner.kind === "ReplicaSet")) {
      if (visited.has(owner.metadata.uid)) throw new Error("Cyclic Kubernetes controller ownership");
      visited.add(owner.metadata.uid);
      const ref = owner.metadata.ownerReferences.find((item) => item.controller);
      if (!ref) break;
      if (![...kinds, "ReplicaSet"].includes(ref.kind)) { owner = undefined; break; }
      const parent = byUid.get(ref.uid);
      // A rollout may race the five reads. Retry the sample instead of reporting false deletions.
      if (!parent) throw new Error(`Incomplete controller ownership for Pod ${pod.name}`);
      owner = parent;
    }
    if (!owner || owner.kind === "ReplicaSet") continue;
    const group = workloadPods.get(owner.metadata.uid) ?? [];
    group.push({ name: pod.name, uid: pod.uid!, phase: pod.phase, ready: pod.conditions.some((condition) => condition.type === "Ready" && condition.status === "True"),
      terminating: Boolean(byUid.get(pod.uid!)!.metadata.deletionTimestamp),
      containers: pod.containers.map((container) => ({ name: container.name, image: container.image,
        imageId: container.imageId ?? "", lastExitReason: container.lastTermination?.reason ?? "", ready: container.ready ?? false, restarts: container.restartCount,
        state: container.state?.kind ?? "unknown", reason: container.state && "reason" in container.state ? container.state.reason ?? "" : "",
      })).sort(byName) });
    workloadPods.set(owner.metadata.uid, group);
  }
  const workloads: WorkloadSnapshot[] = resources.filter((item) => item.kind !== "ReplicaSet"
    && (item.kind !== "Pod" || !item.metadata.ownerReferences.some((ref) => ref.controller))).map((item) => ({
      kind: item.kind as WorkloadSnapshot["kind"], name: item.metadata.name, uid: item.metadata.uid,
      generation: item.metadata.generation ?? 0,
      desired: item.kind === "DaemonSet" ? item.status.desiredNumberScheduled ?? 0 : item.spec.replicas ?? 1,
      ready: item.kind === "DaemonSet" ? item.status.numberReady ?? 0 : item.kind === "Pod"
        ? Number(workloadPods.get(item.metadata.uid)?.[0]?.ready ?? false) : item.status.readyReplicas ?? 0,
      images: [...item.spec.template?.spec.containers ?? []].sort(byName),
      pods: (workloadPods.get(item.metadata.uid) ?? []).sort(byName),
    })).sort((a, b) => a.kind.localeCompare(b.kind) || byName(a, b));
  return { environment, namespace, observedAt: new Date().toISOString(), workloads };
}

export function observationNamespace(environment: EnvironmentDefinition, namespace?: string): string {
  if (environment.kind !== "kubernetes" || !("kubeconfig" in environment)) throw new Error(`Environment ${environment.name} is not Kubernetes`);
  if (environment.host?.transport === "ssh") throw new Error(`Environment ${environment.name}: workload observation requires local Kubernetes access; SSH Host is unsupported`);
  const selected = namespace ?? environment.namespace;
  if (!selected?.trim()) throw new Error(`Environment ${environment.name}: workload observation requires an explicit namespace`);
  return selected;
}

export async function readWorkloads(environment: EnvironmentDefinition, namespace?: string): Promise<EnvironmentSnapshot> {
  const selected = observationNamespace(environment, namespace);
  if (!("kubeconfig" in environment)) throw new Error("Kubernetes access is missing");
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error("Environment observation timed out")), 25_000);
  try {
    const kubeconfig = environment.kubeconfig.startsWith("~/") ? join(homedir(), environment.kubeconfig.slice(2)) : environment.kubeconfig;
    const access = resourceAccess({ kubeconfig, context: environment.context }, abort.signal,
      { timeoutMs: 10_000, concurrency: 2, maxBytes: 8 * 1024 * 1024 });
    return await collectWorkloads(access, environment.name, selected);
  } finally { clearTimeout(timeout); abort.abort(); }
}

/** All reads must succeed; an unavailable list is never an empty list. */
export async function collectWorkloads(access: ResourceAccess, environment: string, namespace: string): Promise<EnvironmentSnapshot> {
  const endpoints = { deployments: "Deployment", statefulsets: "StatefulSet", daemonsets: "DaemonSet", replicasets: "ReplicaSet", pods: "Pod" };
  const lists = await Promise.all(Object.entries(endpoints).map(async ([endpoint, kind]) => {
    const list = ListSchema.parse(await access.get(namespace, endpoint));
    // Typed API lists may omit kind on each item; the endpoint supplies it.
    return { ...list, items: list.items.map((item) => ({ ...z.record(z.string(), z.unknown()).parse(item), kind })) };
  }));
  return workloadSnapshot(lists, environment, namespace);
}
