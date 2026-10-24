import type { WorkloadSnapshot } from "@compforge/aide-plugin";

export interface WorkloadChange { before?: WorkloadSnapshot; after?: WorkloadSnapshot }
export interface WorkloadEvent {
  type: "workload.changed";
  environment: string;
  namespace: string;
  observedAt: string;
  previousObservedAt: string;
  changes: WorkloadChange[];
}
const preview = (text: string, max = 220) => text.length > max ? text.slice(0, max) + "…（详情见证据）" : text;
const images = (w: WorkloadSnapshot) => w.images.map(i => `${i.name}=${i.image}`).sort().join(", ");
const runtimeImages = (w: WorkloadSnapshot) => [...new Set(w.pods.flatMap(p => p.containers.map(c => `${c.name}=${c.imageId}`)).filter(s => !s.endsWith("=")))].sort().join(", ");
const containerState = (c: WorkloadSnapshot["pods"][number]["containers"][number]) =>
  `${c.state}${c.reason ? "/" + c.reason : ""},ready=${c.ready}${c.lastExitReason ? ",lastExit=" + c.lastExitReason : ""}`;

/** Facts only: Pod churn is not proof of a deployment, and restart deltas require the same Pod UID/container. */
function describeChange({ before, after }: WorkloadChange): string {
  const workload = after ?? before!;
  const label = `${workload.kind} ${workload.name}`;
  if (!after) return `- ${label}：移除`;
  const fields: string[] = [];
  if (!before) fields.push("新增", `镜像 ${preview(images(after))}`);
  else {
    if (before.uid !== after.uid) fields.push("Workload UID 变化");
    if (before.generation !== after.generation) fields.push(`generation ${before.generation} → ${after.generation}`);
    fields.push(images(before) === images(after) ? "镜像声明未变" : `镜像 ${preview(images(before))} → ${preview(images(after))}`);
    if (runtimeImages(before) !== runtimeImages(after)) fields.push("运行镜像标识集合变化（详情见证据）");
  }
  fields.push(before && (before.ready !== after.ready || before.desired !== after.desired)
    ? `就绪副本 ${before.ready}/${before.desired} → ${after.ready}/${after.desired}`
    : `就绪副本 ${after.ready}/${after.desired}${before ? "（未变）" : ""}`);
  const oldPods = new Map((before?.pods ?? []).map(p => [p.uid, p]));
  const newPods = new Map(after.pods.map(p => [p.uid, p]));
  const added = after.pods.filter(p => !oldPods.has(p.uid)).length;
  const removed = (before?.pods ?? []).filter(p => !newPods.has(p.uid)).length;
  if (added || removed) fields.push(`Pod 新增 ${added}、移除 ${removed}`);
  let restarts = 0, newRestarts = 0, resets = 0;
  const transitions = new Map<string, number>();
  const record = (text: string) => transitions.set(text, (transitions.get(text) ?? 0) + 1);
  for (const pod of after.pods) {
    const previous = oldPods.get(pod.uid);
    if (previous && (previous.phase !== pod.phase || previous.ready !== pod.ready || previous.terminating !== pod.terminating)) {
      record(`Pod ${previous.phase}/ready=${previous.ready}/terminating=${previous.terminating} → ${pod.phase}/ready=${pod.ready}/terminating=${pod.terminating}`);
    } else if (!previous && (!pod.ready || !["Running", "Succeeded"].includes(pod.phase))) record(`新 Pod ${pod.phase}/ready=${pod.ready}`);
    for (const container of pod.containers) {
      const old = previous?.containers.find(c => c.name === container.name);
      if (old) {
        const delta = container.restarts - old.restarts;
        if (delta >= 0) restarts += delta; else resets++;
        if (containerState(old) !== containerState(container)) record(`容器 ${containerState(old)} → ${containerState(container)}`);
        else if (delta > 0 && container.lastExitReason) record(`重启容器最近退出 ${container.lastExitReason}`);
      } else {
        newRestarts += container.restarts;
        if (!container.ready || container.reason || container.lastExitReason) record(`新增容器 ${containerState(container)}`);
      }
    }
  }
  if (restarts) fields.push(`同一 Pod/容器重启 +${restarts}`);
  if (newRestarts) fields.push(`新增 Pod/容器已有重启 ${newRestarts}（不计入同实例增量）`);
  if (resets) fields.push(`${resets} 个容器重启计数回退（详情见证据）`);
  const states = [...transitions.entries()];
  for (const [state, count] of states.slice(0, 4)) fields.push(`${preview(state)} ×${count}`);
  if (states.length > 4) fields.push(`另有 ${states.length - 4} 类状态变化，见证据`);
  if (before && fields.length === 2) fields.push("其余运行细节变化，见证据");
  return `- ${label}：${fields.join("；")}`;
}

/**
 * @spec Input.text is a compact factual delta; the unabridged before/after remains in Input.observation.
 * @link docs/connector/environments.md#environment-变化
 */
export function describeWorkloadChanges(event: WorkloadEvent): string {
  const lines = event.changes.slice(0, 20).map(change => preview(describeChange(change), 1100));
  if (event.changes.length > lines.length) lines.push(`其余 ${event.changes.length - lines.length} 项变化见完整观察数据。`);
  return preview(`${event.environment} / ${event.namespace}：${event.changes.length} 项 Workload 变化。\n\n${lines.join("\n")}`, 24000);
}
