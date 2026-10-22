import "./style.css";
import { applyPatch, parsePatchEvent } from "@compforge/agentue/ui";
import type { ConversationView } from "../../channel/view.ts";
import type { Approval } from "../../api/types.ts";
import type { Work } from "../../../plugins/personal/model.ts";
import { byId } from "../shared/dom.ts";
import { request } from "../shared/http.ts";
import { createNavigation } from "./navigation.ts";
import { createTimeline } from "./timeline.ts";
import { createWorkPanel } from "./work.ts";
import { createApprovals } from "./approvals.ts";
import { mountComposer } from "./composer.ts";

const conversationId = new URL(location.href).searchParams.get("conversation");
const query = "?conversationId=" + encodeURIComponent(conversationId ?? "");
const lifetime = new AbortController();
const navigation = createNavigation(conversationId, lifetime.signal);
const timeline = createTimeline();
const work = createWorkPanel(conversationId ?? "", poll);
const approvals = createApprovals(poll);
let polling = false;
let timer: ReturnType<typeof setInterval> | undefined;
let stream: EventSource | undefined;

/** @spec Polling failures never replace submission results or stream connection status. */
async function poll() {
  if (polling) return;
  polling = true;
  try {
    if (!conversationId) { await navigation.refresh(); return; }
    const [works, pending] = await Promise.all([
      request<Work[]>("/work" + query), request<Approval[]>("/approvals" + query), navigation.refresh(),
    ]);
    work.render(works); approvals.render(pending);
    byId("poll-notice").textContent = "";
  } catch { byId("poll-notice").textContent = "事项或审批暂时无法更新，正在重试。"; }
  finally { polling = false; }
}

function start() {
  if (timer !== undefined) return;
  void poll(); timer = setInterval(poll, 1500);
  if (!conversationId) return;
  const connection = new EventSource("/stream" + query);
  stream = connection;
  let view = {};
  connection.onmessage = (event) => {
    try {
      const patch = parsePatchEvent(event.data);
      view = applyPatch(view, patch);
      if (patch.op === "ping" || patch.op === "end") return;
      const snapshot = view as ConversationView;
      timeline.render(snapshot);
      byId("connection").textContent = snapshot.meta.error?.message ?? "实时连接";
    } catch (error) {
      console.error("Unable to render conversation progress", error);
      connection.close(); byId("connection").textContent = "无法读取对话进展，请刷新页面重试";
    }
  };
  connection.onopen = () => { byId("connection").textContent = "实时连接"; };
  connection.onerror = () => { byId("connection").textContent = "连接断开 · 正在重连"; };
}

if (conversationId) mountComposer(conversationId, poll);
else {
  byId("composer").hidden = true;
  byId("notice").textContent = "选择已有会话，或新建对话；可以将常用私聊设为默认联络处。";
  byId("connection").textContent = "";
}
// @spec A cached page keeps its UI state, but restarts exactly one polling timer and stream on return.
window.addEventListener("pagehide", (event) => {
  clearInterval(timer); timer = undefined;
  stream?.close(); stream = undefined;
  if (!event.persisted) lifetime.abort();
});
window.addEventListener("pageshow", (event) => { if (event.persisted) start(); });
start();
