import "./style.css";
import { applyPatch, parsePatchEvent } from "@compforge/agentue/ui";
import type { TopicView } from "../../channel/view.ts";
import type { Approval } from "../../api/types.ts";
import type { Work } from "../../../plugins/personal/model.ts";
import { byId } from "../shared/dom.ts";
import { request } from "../shared/http.ts";
import { createNavigation } from "./navigation.ts";
import { createTimeline } from "./timeline.ts";
import { createWorkPanel } from "./work.ts";
import { createTopicContextPanel } from "./context.ts";
import { createApprovals } from "./approvals.ts";
import { mountComposer } from "./composer.ts";
import { createTopicTree } from "./tree.ts";
import { mountTopicTabs } from "./tabs.ts";

const lifetime = new AbortController();
let timer: ReturnType<typeof setInterval> | undefined;
const initialId = new URL(location.href).searchParams.get("topic");
const navigation = createNavigation(initialId, lifetime.signal, (id) => {
  current.dispose();
  current = mountTopic(id);
  if (timer !== undefined) { void current.poll(); current.connect(); }
});
let current = mountTopic(initialId);

/** @spec A selected topic owns its requests, composer and stream; retired responses cannot update the next scope. */
function mountTopic(topicId: string | null) {
  const controller = new AbortController();
  const signal = controller.signal;
  const query = "?topicId=" + encodeURIComponent(topicId ?? "");
  const timeline = createTimeline();
  let latestView: TopicView | undefined;
  const tree = createTopicTree(topicId, signal);
  const tabs = mountTopicTabs(!!topicId, signal, () => {
    if (latestView) timeline.render(latestView);
  }, () => tree.show());
  const work = createWorkPanel(topicId ?? "", poll, signal);
  const context = createTopicContextPanel();
  const approvals = createApprovals(poll, signal);
  let polling = false;
  let stream: EventSource | undefined;

  byId("history").replaceChildren();
  byId("activity").replaceChildren(); byId("activity").hidden = true;
  byId("messages").scrollTop = 0;
  byId("poll-notice").textContent = "";
  byId("work-notice").textContent = "";
  byId("notice").className = "";
  byId<HTMLTextAreaElement>("input").value = "";
  byId<HTMLTextAreaElement>("input").disabled = false;
  byId<HTMLButtonElement>("send").disabled = false;
  byId("composer").hidden = !topicId;
  context.render(null); work.render([]); approvals.render([]);
  if (topicId) {
    byId("connection").textContent = "连接中";
    byId("notice").textContent = "Enter 发送 · Shift + Enter 换行";
    mountComposer(topicId, poll, signal);
  } else {
    byId("notice").textContent = "选择已有主题，或新建对话；默认主题承接暂时无法归类的信息。";
    byId("connection").textContent = "";
  }

  /** @spec Polling failures never replace submission results or stream connection status. */
  async function poll() {
    if (polling || signal.aborted || document.hidden) return;
    polling = true;
    try {
      if (!topicId) { await navigation.refresh(); return; }
      const [works, pending] = await Promise.all([
        request<Work[]>("/work" + query, { signal }), request<Approval[]>("/approvals" + query, { signal }), navigation.refresh(),
      ]);
      if (signal.aborted) return;
      work.render(works); approvals.render(pending);
      byId("poll-notice").textContent = "";
    } catch { if (!signal.aborted) byId("poll-notice").textContent = "事项或审批暂时无法更新，正在重试。"; }
    finally { polling = false; }
  }

  function connect() {
    if (!topicId || stream || signal.aborted) return;
    const connection = new EventSource("/stream" + query);
    stream = connection;
    let view = {};
    connection.onmessage = (event) => {
      if (stream !== connection || signal.aborted) return;
      try {
        const patch = parsePatchEvent(event.data);
        view = applyPatch(view, patch);
        if (patch.op === "ping" || patch.op === "end") return;
        const snapshot = view as TopicView;
        latestView = snapshot;
        context.render(snapshot.meta.context);
        if (tabs.isDialogue()) timeline.render(snapshot);
        byId("connection").textContent = snapshot.meta.error?.message ?? "实时连接";
      } catch (error) {
        console.error("Unable to render topic progress", error);
        connection.close(); byId("connection").textContent = "无法读取对话进展，请刷新页面重试";
      }
    };
    connection.onopen = () => { if (stream === connection && !signal.aborted) byId("connection").textContent = "实时连接"; };
    connection.onerror = () => { if (stream === connection && !signal.aborted) byId("connection").textContent = "连接断开 · 正在重连"; };
  }
  function pause() { stream?.close(); stream = undefined; }
  return { poll, connect, pause, dispose() { controller.abort(); pause(); } };
}

function start() {
  if (timer !== undefined) return;
  void current.poll(); timer = setInterval(() => void current.poll(), 5000);
  current.connect();
}

// @spec A cached page keeps its UI state, but restarts exactly one polling timer and stream on return.
window.addEventListener("pagehide", (event) => {
  clearInterval(timer); timer = undefined;
  current.pause();
  if (!event.persisted) { current.dispose(); lifetime.abort(); }
});
window.addEventListener("pageshow", (event) => { if (event.persisted) start(); });
start();
