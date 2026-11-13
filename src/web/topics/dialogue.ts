import { applyPatch, parsePatchEvent } from "@compforge/agentue/ui";
import type { TopicView } from "../../channel/view.ts";
import { byId } from "../shared/dom.ts";
import { request } from "../shared/http.ts";
import { createTimeline } from "./timeline.ts";
import { createDialogueHistory } from "./history.ts";

/** @spec Upward scrolling loads ten older records without stopping live updates, replacing the transcript or moving the reader's anchor. */
export function createDialogue(topicId: string | null, signal: AbortSignal, visible: () => boolean) {
  const timeline = createTimeline(), history = createDialogueHistory();
  let stream: EventSource | undefined;
  let loading = false, failed = false;
  const messages = byId("messages"), notice = byId("history-notice");
  const retry = byId<HTMLButtonElement>("history-retry");
  let previousTop = messages.scrollTop;
  retry.hidden = true;
  notice.textContent = topicId ? "加载中…" : "";
  function status() {
    retry.hidden = !failed;
    notice.textContent = failed ? "历史记录加载失败。" : loading ? "加载中…"
      : history.hasOlder() ? "向上滚动加载更早记录" : "已到最早记录";
  }
  function render(preservePosition = false) {
    const view = history.view();
    if (view && visible()) timeline.render(view, preservePosition);
    previousTop = messages.scrollTop;
  }
  function pause() { stream?.close(); stream = undefined; byId("connection").textContent = ""; }
  async function load(older = false) {
    if (!topicId || loading || signal.aborted || !visible()) return;
    const pending = history.next(older);
    if (!pending) return;
    loading = true; failed = false; status();
    try {
      const page = await request<TopicView>("/topics/history?" + new URLSearchParams({ topicId, before: pending.before }), { signal });
      if (signal.aborted) return;
      history.accept(pending, page);
      render(!pending.until);
    } catch { if (!signal.aborted) failed = true; }
    finally {
      loading = false;
      if (!signal.aborted) { status(); if (!failed && history.hasGap()) void load(); }
    }
  }
  const nearTop = () => messages.scrollTop <= 120;
  messages.addEventListener("scroll", () => {
    const upward = messages.scrollTop < previousTop;
    previousTop = messages.scrollTop;
    if (upward && nearTop() && !failed) void load(true);
  }, { signal, passive: true });
  // A short first page may not overflow; upward wheel/keyboard intent still permits loading history.
  messages.addEventListener("wheel", event => { if (event.deltaY < 0 && nearTop() && !failed) void load(true); }, { signal, passive: true });
  messages.addEventListener("keydown", event => {
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) && nearTop() && !failed) void load(true);
  }, { signal });
  retry.addEventListener("click", () => void load(true), { signal });
  function connect() {
    if (!topicId || stream || signal.aborted || !visible()) return;
    const connection = new EventSource("/stream?topicId=" + encodeURIComponent(topicId));
    stream = connection;
    byId("connection").textContent = "连接中";
    let view = {};
    connection.onmessage = (event) => {
      if (stream !== connection || signal.aborted) return;
      try {
        const patch = parsePatchEvent(event.data);
        view = applyPatch(view, patch);
        if (patch.op === "ping" || patch.op === "end") return;
        const snapshot = view as TopicView;
        history.live(snapshot); render();
        if (!failed) { status(); void load(); }
        byId("connection").textContent = snapshot.meta.error?.message ?? "实时连接";
      } catch (error) {
        console.error("Unable to render topic progress", error);
        pause(); byId("connection").textContent = "无法读取对话进展，请重新打开对话重试。";
      }
    };
    connection.onerror = () => { if (stream === connection && !signal.aborted) byId("connection").textContent = "连接断开 · 正在重连"; };
  }
  return { pause, show() { render(); connect(); if (!failed) void load(); } };
}
