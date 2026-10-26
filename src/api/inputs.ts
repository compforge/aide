import { inputSessions } from "../../plugins/personal/observation/job.ts";
import type { ResourceRef, ResourceNamespace } from "@compforge/aide-plugin";
import { browseInputs, inputFacets, type InputBrowseQuery } from "../../plugins/personal/input/browse.ts";
import type { Attempt, Assessment, Handling } from "../../plugins/personal/input/model.ts";
import type { ChannelService } from "../channel/service.ts";
import { inputPrinter } from "../../plugins/personal/input/printer.ts";

export interface InputConsumer {
  ref: ResourceRef; label: string; available: boolean; topicId?: string;
}
export interface InputTimelineEntry {
  id: string; at?: string; stage: "receive" | "route" | "assess" | "handle" | "output";
  title: string; text?: string; status?: string; consumer?: InputConsumer; executionId?: string;
}
function definition(aide: ChannelService, input: { origin: "channel" | "source" | "chief"; originId: string }) {
  try { return aide.inputDefinition(input).label; }
  catch { return `${input.origin} / ${input.originId}`; }
}
export function inputList(aide: ChannelService, query: InputBrowseQuery) {
  const store = aide.topics.inputStore, result = browseInputs(store, query), facets = inputFacets(store);
  return { ...result, items: result.items.map(({ input, ...state }) => ({
    ...state, id: input.metadata.name, uid: input.metadata.uid, at: input.metadata.creationTimestamp,
    origin: input.spec.origin, originId: input.spec.originId, label: definition(aide, input.spec),
    preview: inputPrinter.summarize(input), source: input.spec.originRef,
    assessments: Object.keys(input.status.assess ?? {}).length, handlings: Object.keys(input.status.handle ?? {}).length,
  })), filters: {
    origins: [...new Map(facets.map(f => [`${f.origin}:${f.originId}`, { value: `${f.origin}:${f.originId}`, label: `${definition(aide, f)} · ${f.origin}` }])).values()],
    connectors: [...new Set(facets.map(f => f.connector))].sort().map(value => ({ value, label: value || "无 Connector / 未记录" })),
    sources: [...new Map(facets.filter(f => f.sourceUid).map(f => [f.sourceUid, { value: f.sourceUid, label: `${f.sourceKind} / ${f.sourceName}` }])).values()],
  } };
}

/**
 * @spec Timeline projects retained Input receipts and explicitly associated Outputs, never adjacency or agent end_turn.
 * @spec Consumer links resolve the exact UID. Deleted or recreated consumers leave their original receipts visible.
 * @why Input status is not a complete retry log; unrecorded timestamps must stay absent.
 * @link docs/personal/input.md
 */
export function inputDetail(aide: ChannelService, id: string, uid?: string) {
  const input = aide.topics.inputStore.get(id);
  if (!input || input.metadata.deletionTimestamp || (uid !== undefined && uid !== input.metadata.uid)) return;
  const timeline: InputTimelineEntry[] = [{ id: "received", at: input.metadata.creationTimestamp, stage: "receive", title: "接收 Input", text: definition(aide, input.spec), status: "completed" }];
  const consumer = (ref: ResourceRef): InputConsumer => {
    const current = aide.topics.resources.find<Record<string, unknown>, unknown>(ref, ref.name, ref.namespace as ResourceNamespace);
    const available = !!current && current.metadata.uid === ref.uid && !current.metadata.deletionTimestamp;
    const spec = available ? current.spec : undefined;
    const label = spec && [spec.name, spec.title, spec.id].find(value => typeof value === "string");
    const topicId = spec && (ref.kind === "Topic" ? spec.id : spec.topicId);
    return { ref, label: typeof label === "string" ? label : ref.name, available,
      ...(typeof topicId === "string" ? { topicId } : {}) };
  };
  const attempt = (key: string, stage: "route" | "assess" | "handle", value: Attempt, assigned?: Assessment) => {
    const target = assigned && consumer(assigned.resource), label = stage === "route" ? "路由" : stage === "assess" ? "根主题研判" : "Work 办理";
    const append = (suffix: string, title: string, at?: string, text?: string, status?: string) => timeline.push({
      id: `${key}:${suffix}`, stage, title, at, text, status, consumer: target, executionId: value.executionId,
    });
    if (assigned) append("assigned", stage === "assess" ? "交给根主题处理" : "交给 Work", assigned.assignedAt,
      stage === "handle" ? JSON.stringify((assigned as Handling).request, null, 2) : undefined, "assigned");
    if (stage === "handle" && (value as Handling).appliedAt) append("applied", "Work 已应用请求", (value as Handling).appliedAt, undefined, "applied");
    if (value.startedAt) append("started", `${label}开始（最近记录）`, value.startedAt, undefined, "started");
    if (value.completedAt) append("completed", `${label}${assigned?.result?.disposition === "cancelled" ? "取消" : assigned?.result?.disposition === "rejected" ? "拒绝" : "完成"}`,
      value.completedAt, assigned?.result?.summary, assigned?.result?.disposition ?? "completed");
    if (value.lastError) append("error", `${label}异常记录`, undefined, value.lastError, value.completedAt ? "recorded" : "attention");
    if (!value.completedAt) append("pending", `${label}尚未确认完成`, undefined, undefined, "pending");
  };
  const route = input.status.route;
  if (route) {
    attempt("route", "route", route);
    for (const target of route.result?.topics ?? []) timeline.push({ id: `binding:${target.uid}`, at: route.completedAt, stage: "route", title: "绑定来源主题", consumer: consumer(target), status: "bound" });
    if (route.result) timeline.push({ id: "route:result", at: route.completedAt, stage: "route", title: "路由结果", text: route.result.reason,
      status: `${route.result.topics.length} 个主题` });
    if (!route.completedAt && route.nextAttemptAt) timeline.push({ id: "route:retry", stage: "route", title: "路由等待重试", text: `计划重试时间：${route.nextAttemptAt}`, status: "retrying" });
  } else timeline.push({ id: "route:pending", stage: "route", title: "等待路由", status: "pending" });
  for (const [key, value] of Object.entries(input.status.assess ?? {})) attempt(`assess:${key}`, "assess", value, value);
  for (const [key, value] of Object.entries(input.status.handle ?? {})) attempt(`handle:${key}`, "handle", value, value);
  const outputs = aide.topics.outputStore.list({ inputId: id });
  for (const output of outputs) {
    const target = consumer(output.spec.topic);
    timeline.push({ id: `output:${output.metadata.name}`, stage: "output", at: output.metadata.creationTimestamp, title: "创建 Output",
      text: output.spec.text, status: output.status.phase, consumer: target, executionId: output.spec.executionId });
    if (output.status.deliveredAt) timeline.push({ id: `output:${output.metadata.name}:delivered`, stage: "output", at: output.status.deliveredAt,
      title: "Output 已送达", status: "delivered", consumer: target });
    if (output.status.lastError) timeline.push({ id: `output:${output.metadata.name}:error`, stage: "output", title: "Output 投递异常记录", text: output.status.lastError, status: output.status.phase, consumer: target });
  }
  timeline.sort((a, b) => a.at && b.at ? a.at.localeCompare(b.at) : a.at ? -1 : b.at ? 1 : 0);
  return { input, sessions: inputSessions(input, outputs), label: definition(aide, input.spec), timeline, outputCount: outputs.length,
    routeAttempts: route?.attempts ?? 0,
    outputs: outputs.map(o => ({ id: o.metadata.name, target: o.spec.target, status: o.status })) };
}
