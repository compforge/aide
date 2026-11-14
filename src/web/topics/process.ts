import type { TopicBlock, TopicView } from "../../channel/view.ts";
import { replyPreview, replyLabels, toolLabels } from "../../channel/reply-layout.ts";
import { byId, element, find } from "../shared/dom.ts";
import { request, errorMessage } from "../shared/http.ts";
import { updateMarkdown } from "../shared/markdown.ts";

export const executionLabel = (phase?: string) => ({ completed: "已完成", interrupted: "已中断", cancelled: "已取消", uncertain: "结果待确认", unknown: "执行记录不可用" }[phase ?? ""] ?? replyLabels[phase ?? ""] ?? "执行记录不可用");
export function executionDuration(block: TopicBlock) {
  if (!block.at || !block.endedAt) return "";
  const seconds = Math.max(0, Math.round((Date.parse(block.endedAt) - Date.parse(block.at)) / 1000));
  return ` · ${seconds < 60 ? seconds + " 秒" : Math.floor(seconds / 60) + " 分 " + seconds % 60 + " 秒"}`;
}

/**
 * @spec A single reader-selected execution owns the pane. New replies never switch selection or reset expanded steps.
 * @spec Process requests are lazy, incarnation-bound and cancelled on close, navigation or pause; stale responses cannot replace another selection.
 * @link docs/channel/web.md#实时进展与历史
 */
export function createProcessPane(topicId: string | null, signal: AbortSignal) {
  const layout = byId("panel-dialogue");
  const pane = element("aside", undefined, "process-pane"); pane.id = "process-pane"; pane.hidden = true;
  pane.setAttribute("aria-label", "执行过程");
  const header = element("div", undefined, "process-heading"), title = element("h3", "执行过程");
  const closeButton = element("button", "关闭 ×"); closeButton.type = "button";
  const subtitle = element("p", "", "muted process-subtitle"), status = element("p", "", "muted"); status.setAttribute("role", "status");
  const body = element("div", undefined, "process-body");
  header.append(title, closeButton); pane.append(header, subtitle, status, body); layout.append(pane);
  let selected: { id: string; uid: string; title: string } | undefined;
  let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let paused = false, returnFocus: HTMLElement | undefined, retry: HTMLButtonElement | undefined;
  const nodes = new Map<string, HTMLElement>();
  function stop() { controller?.abort(); controller = undefined; clearTimeout(timer); }
  function close() {
    stop(); selected = undefined; pane.hidden = true; layout.classList.remove("process-open");
    const url = new URL(location.href); url.searchParams.delete("process"); url.searchParams.delete("processTopicUid");
    history.replaceState(null, "", url); returnFocus?.focus();
  }
  closeButton.addEventListener("click", close, { signal });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && selected) close(); }, { signal });
  signal.addEventListener("abort", () => { stop(); pane.remove(); layout.classList.remove("process-open"); }, { once: true });
  function render(view: TopicView) {
    const executions = view.blocks.filter(b => b.type === "execution" && b.group_id === selected?.id);
    const running = executions.some(b => b.status === "running" || b.status === "queued") || view.meta.activity?.id === selected?.id;
    const question = view.blocks.find(b => b.type === "input" && b.group_id === selected?.id);
    if (question) subtitle.textContent = replyPreview(question.content);
    status.textContent = executions.length ? executions.map(b => `${b.label ?? "执行"} · ${executionLabel(b.status)}${executionDuration(b)}`).join("；")
      : running ? "正在准备执行记录…" : "执行详情未保留（可能已重启或超出保留范围），正文仍可阅读。";
    const answers = view.blocks.filter(b => b.type === "message");
    const steps = executions.flatMap(run => [run, ...view.blocks.filter(b => b.parent_id === run.id &&
      (b.type !== "text" || !answers.some(answer => answer.content === b.content)))]);
    const ids = new Set(steps.map(b => b.id));
    for (const [id, node] of nodes) if (!ids.has(id)) { node.remove(); nodes.delete(id); }
    for (const block of steps) {
      let node = nodes.get(block.id);
      if (!node) {
        node = element(block.type === "execution" ? "section" : "details", undefined, "process-step " + block.type);
        node.dataset.blockId = block.id;
        if (node instanceof HTMLDetailsElement) { node.open = block.type !== "tool"; node.append(element("summary")); }
        else node.append(element("h4"));
        node.append(element("div", undefined, "activity-content")); nodes.set(block.id, node);
      }
      const heading = find(node, block.type === "execution" ? "h4" : "summary");
      heading.textContent = block.type === "execution" ? `${block.label ?? "执行"} · ${executionLabel(block.status)}${executionDuration(block)}`
        : block.type === "tool" ? `${block.content} · ${toolLabels[block.status ?? ""] ?? block.status ?? "状态未知"}`
        : block.type === "thought" ? "思考摘要" : "执行说明";
      const content = find(node, ".activity-content");
      if (block.type === "tool" || block.type === "execution") content.textContent = block.detail ?? "";
      else { content.classList.add("markdown"); updateMarkdown(content, block.content); }
      // Move existing nodes only when order changed, preserving reader-owned details state.
      const position = steps.indexOf(block);
      if (body.children[position] !== node) body.insertBefore(node, body.children[position] ?? null);
    }
    return running;
  }
  async function refresh() {
    if (!selected || paused || signal.aborted || !topicId) return;
    const selection = selected, pending = new AbortController(); controller = pending; retry?.remove(); retry = undefined;
    try {
      const view = await request<TopicView>("/topics/process?" + new URLSearchParams({ topicId, topicUid: selection.uid, executionId: selection.id }), { signal: pending.signal });
      if (pending.signal.aborted || selection !== selected) return;
      const running = render(view);
      if (running) timer = setTimeout(() => void refresh(), 1500);
    } catch (error) {
      if (pending.signal.aborted || selection !== selected) return;
      status.textContent = errorMessage(error);
      retry = element("button", "重试加载过程"); retry.type = "button";
      retry.addEventListener("click", () => void refresh(), { once: true }); body.append(retry);
    }
  }
  function open(id: string, uid: string, text: string, trigger?: HTMLElement) {
    if (selected?.id === id && selected.uid === uid) { closeButton.focus(); return; }
    stop(); selected = { id, uid, title: text }; returnFocus = trigger;
    nodes.clear(); body.replaceChildren(); body.scrollTop = 0;
    pane.hidden = false; layout.classList.add("process-open"); subtitle.textContent = replyPreview(text) || "本次执行";
    status.textContent = "加载执行过程…";
    const url = new URL(location.href); url.searchParams.set("process", id); url.searchParams.set("processTopicUid", uid);
    history.replaceState(null, "", url); closeButton.focus(); void refresh();
  }
  return { open, pause() { paused = true; stop(); }, show() { if (paused) { paused = false; void refresh(); } } };
}
