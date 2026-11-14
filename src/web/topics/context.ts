import { renderNoteClassification } from "../shared/note-classification.ts";
import type { topicSummary, browseTopicNotes } from "../../api/topic.ts";
import { request } from "../shared/http.ts";
import { byId, element } from "../shared/dom.ts";
import { updateMarkdown } from "../shared/markdown.ts";

/** @spec Each knowledge tab owns its request and distinguishes pending/error from successfully loaded empty data. */
export function createTopicContextPanel(topicId: string | null, signal: AbortSignal) {
  const panels = { summary: byId("topic-summary"), recent: byId("topic-recent") };
  const state = { summary: { loading: false, signature: "" }, recent: { loading: false, signature: "", page: 1, pages: 1, requestedPage: 1 } };
  let buttons: { button: HTMLButtonElement; delta: number }[] = [];
  function updateButtons() {
    for (const { button, delta } of buttons) button.disabled = state.recent.loading || (delta < 0 ? state.recent.page <= 1 : state.recent.page >= state.recent.pages);
  }
  updateMarkdown(panels.summary, "加载中…");
  panels.recent.replaceChildren(element("p", "加载中…", "muted"));
  async function load(kind: "summary" | "recent", page = state.recent.requestedPage) {
    if (!topicId || signal.aborted || state[kind].loading) return;
    state[kind].loading = true;
    if (kind === "recent") { state.recent.requestedPage = page; updateButtons(); }
    const panel = panels[kind];
    panel.setAttribute("aria-busy", "true");
    try {
      const query = new URLSearchParams({ topicId });
      if (kind === "recent") { query.set("page", String(page)); query.set("pageSize", "5"); }
      const data = await request<ReturnType<typeof topicSummary> | ReturnType<typeof browseTopicNotes>>(`/topics/${kind === "recent" ? "notes" : kind}?` + query, { signal });
      if (signal.aborted) return;
      panel.querySelector(".load-error")?.remove();
      if (kind === "recent") state.recent.requestedPage = (data as ReturnType<typeof browseTopicNotes>).page;
      const signature = JSON.stringify(data);
      if (state[kind].signature === signature) return;
      state[kind].signature = signature;
      if (kind === "summary") renderSummary(data as ReturnType<typeof topicSummary>);
      else renderRecent(data as ReturnType<typeof browseTopicNotes>);
    } catch {
      if (signal.aborted) return;
      if (!state[kind].signature) panel.replaceChildren();
      if (!panel.querySelector(".load-error")) panel.append(element("p", "加载失败，正在重试。", "muted load-error"));
    } finally {
      state[kind].loading = false;
      if (!signal.aborted) { panel.setAttribute("aria-busy", "false"); updateButtons(); }
    }
  }
  function renderSummary(context: ReturnType<typeof topicSummary>) {
    const summary = panels.summary, text = context.summary.trim();
    updateMarkdown(summary, text || "尚未形成话题摘要。");
    summary.classList.toggle("muted", !text);
    renderNoteClassification(summary, context.summaryNote);
  }
  /** @spec Poll the selected Note page; failed navigation preserves the displayed page and retries the requested page. */
  function renderRecent(result: ReturnType<typeof browseTopicNotes>) {
    const recent = panels.recent;
    if (state.recent.page !== result.page) recent.scrollTop = 0;
    state.recent.page = state.recent.requestedPage = result.page; state.recent.pages = result.pages;
    recent.replaceChildren();
    const controls = element("nav", undefined, "note-pages"); controls.setAttribute("aria-label", "近期记录分页");
    controls.append(element("span", `共 ${result.total} 条 · 第 ${result.page} / ${result.pages} 页`, "muted"));
    buttons = [];
    for (const [label, delta] of [["上一页", -1], ["下一页", 1]] as const) {
      const button = element("button", label); button.type = "button";
      button.onclick = () => load("recent", state.recent.page + delta);
      buttons.push({ button, delta }); controls.append(button);
    }
    updateButtons(); recent.append(controls);
    if (!result.items.length) recent.append(element("p", "暂无近期记录。", "muted"));
    for (const entry of result.items) {
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
