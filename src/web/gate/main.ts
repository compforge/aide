import "./style.css";
import type { HandoffSummary } from "../../../plugins/personal/handoff/model.ts";
import type { Note } from "../../../plugins/personal/note/model.ts";
import type { Approval } from "../../api/types.ts";
import { byId } from "../shared/dom.ts";
import { request, errorMessage } from "../shared/http.ts";
import { updateMarkdown } from "../shared/markdown.ts";
import { renderNoteClassification } from "../shared/note-classification.ts";
import { createDialogue } from "../topics/dialogue.ts";
import { mountComposer } from "../topics/composer.ts";
import { createApprovals } from "../topics/approvals.ts";
import { mountTopicTabs } from "../topics/tabs.ts";

const lifetime = new AbortController(), signal = lifetime.signal;
let timer: ReturnType<typeof setInterval> | undefined;
let ready = false, polling = false;
const topicId = "gate", query = "?topicId=" + topicId;
const tabs = mountTopicTabs(true, signal, () => { dialogue.pause(); if (tabs.isDialogue()) dialogue.show(); });
const dialogue = createDialogue(topicId, signal, () => ready && timer !== undefined && tabs.isDialogue() && !document.hidden, true);
const approvals = createApprovals(poll, signal);
let handoffCursor = "", expandedHandoffs = false;
const handoffItems = new Map<string, HandoffSummary & { topicUrl?: string }>();
const phases: Record<HandoffSummary["status"]["phase"], string> = { submitted: "已交办", accepted: "已接手", working: "办理中", waiting: "等待", completed: "已完成", failed: "失败" };
function renderHandoffs() {
  const rows = [...handoffItems.values()].map(item => {
    const card = document.createElement("article");
    const title = document.createElement("h3"); title.textContent = item.spec.title;
    const state = document.createElement("p"); state.textContent = phases[item.status.phase] + " · " + item.status.updatedAt;
    const report = document.createElement("p"); report.textContent = item.status.report ?? item.status.request;
    card.append(title, state, report);
    if (item.topicUrl) {
      const link = document.createElement("a"); link.textContent = "查看负责领域";
      link.href = item.topicUrl; card.append(link);
    }
    return card;
  });
  byId("handoffs").replaceChildren(...rows);
  if (!rows.length) byId("handoffs").textContent = "还没有交办记录。";
  byId("handoffs-more").hidden = !handoffCursor;
}
async function loadHandoffs(more = false) {
  const page = await request<{ items: (HandoffSummary & { topicUrl?: string })[]; continue: string }>("/gate/handoffs" + (more ? "?continue=" + encodeURIComponent(handoffCursor) : ""), { signal });
  if (!more && !expandedHandoffs) handoffItems.clear();
  if (more) expandedHandoffs = true;
  for (const item of page.items) handoffItems.set(item.metadata.uid, item);
  if (more || !expandedHandoffs) handoffCursor = page.continue; renderHandoffs();
}
byId("handoffs-more").addEventListener("click", async () => {
  try { await loadHandoffs(true); } catch (error) { byId("poll-notice").textContent = errorMessage(error); }
}, { signal });
mountComposer(topicId, poll, signal, "/gate/messages");

async function poll() {
  if (polling || signal.aborted || document.hidden) return;
  polling = true;
  try {
    if (!ready) {
      await request("/gate/state", { signal });
      if (signal.aborted) return;
      ready = true;
      byId<HTMLTextAreaElement>("input").disabled = false;
      byId<HTMLButtonElement>("send").disabled = false;
      byId("notice").textContent = "Enter 发送 · Shift + Enter 换行";
      if (tabs.isDialogue()) dialogue.show();
    }
    const [, pending] = await Promise.all([loadHandoffs(), request<Approval[]>("/approvals" + query, { signal })]);
    if (signal.aborted) return;
    approvals.render(pending); byId("poll-notice").textContent = "";
  } catch (error) { if (!signal.aborted) byId("poll-notice").textContent = errorMessage(error) + " 正在重试。"; }
  finally { polling = false; }
}
async function evidence() {
  const noteId = new URL(location.href).searchParams.get("note");
  if (!noteId) return;
  const panel = byId<HTMLDetailsElement>("evidence"), body = byId("evidence-body");
  panel.hidden = false; panel.open = true; body.textContent = "加载引用…";
  try {
    const note = await request<Note>("/gate/note?id=" + encodeURIComponent(noteId), { signal });
    if (signal.aborted) return;
    updateMarkdown(body, note.text); renderNoteClassification(body, note);
  } catch (error) { if (!signal.aborted) body.textContent = errorMessage(error); }
}
function start() {
  if (timer !== undefined) return;
  timer = setInterval(() => void poll(), 5000); void poll();
  if (ready && tabs.isDialogue()) dialogue.show();
}
window.addEventListener("pagehide", event => {
  clearInterval(timer); timer = undefined; dialogue.pause();
  if (!event.persisted) lifetime.abort();
});
window.addEventListener("pageshow", event => { if (event.persisted) start(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) dialogue.pause();
  else { void poll(); if (ready && tabs.isDialogue()) dialogue.show(); }
}, { signal });
start(); void evidence();
