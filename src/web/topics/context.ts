import { renderNoteClassification } from "../shared/note-classification.ts";
import type { topicSummary, topicRecent } from "../../api/topic.ts";
import { request } from "../shared/http.ts";
import { byId, element } from "../shared/dom.ts";
import { updateMarkdown } from "../shared/markdown.ts";

/** @spec Each knowledge tab owns its request and distinguishes pending/error from successfully loaded empty data. */
export function createTopicContextPanel(topicId: string | null, signal: AbortSignal) {
  const panels = { summary: byId("topic-summary"), recent: byId("topic-recent") };
  const state = { summary: { loading: false, signature: "" }, recent: { loading: false, signature: "" } };
  updateMarkdown(panels.summary, "加载中…");
  panels.recent.replaceChildren(element("p", "加载中…", "muted"));
  async function load(kind: "summary" | "recent") {
    if (!topicId || signal.aborted || state[kind].loading) return;
    state[kind].loading = true;
    const panel = panels[kind];
    panel.setAttribute("aria-busy", "true");
    try {
      const data = await request<ReturnType<typeof topicSummary> | ReturnType<typeof topicRecent>>(`/topics/${kind}?topicId=${encodeURIComponent(topicId)}`, { signal });
      if (signal.aborted) return;
      panel.querySelector(".load-error")?.remove();
      const signature = JSON.stringify(data);
      if (state[kind].signature === signature) return;
      state[kind].signature = signature;
      if (kind === "summary") renderSummary(data as ReturnType<typeof topicSummary>);
      else renderRecent(data as ReturnType<typeof topicRecent>);
    } catch {
      if (signal.aborted) return;
      if (!state[kind].signature) panel.replaceChildren();
      if (!panel.querySelector(".load-error")) panel.append(element("p", "加载失败，正在重试。", "muted load-error"));
    } finally { state[kind].loading = false; if (!signal.aborted) panel.setAttribute("aria-busy", "false"); }
  }
  function renderSummary(context: ReturnType<typeof topicSummary>) {
    const summary = panels.summary, text = context.summary.trim();
    updateMarkdown(summary, text || "尚未形成话题摘要。");
    summary.classList.toggle("muted", !text);
    renderNoteClassification(summary, context.summaryNote);
  }
  function renderRecent(entries: ReturnType<typeof topicRecent>) {
    const recent = panels.recent;
    recent.replaceChildren();
    if (!entries.length) recent.append(element("p", "暂无近期记录。", "muted"));
    for (const entry of [...entries].reverse()) {
      const item = element("article", undefined, "context-entry");
      const time = element("time", new Date(entry.updatedAt).toLocaleString(), "muted");
      time.dateTime = entry.updatedAt;
      const content = element("div", undefined, "markdown");
      updateMarkdown(content, entry.text);
      item.append(time, content);
      renderNoteClassification(item, entry);
      recent.append(item);
    }
  }
  return { load };
}
