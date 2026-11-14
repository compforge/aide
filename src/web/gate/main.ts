import "./style.css";
import type { Work } from "../../../plugins/personal/model.ts";
import type { Note } from "../../../plugins/personal/note/model.ts";
import type { Approval } from "../../api/types.ts";
import { byId } from "../shared/dom.ts";
import { request, errorMessage } from "../shared/http.ts";
import { updateMarkdown } from "../shared/markdown.ts";
import { renderNoteClassification } from "../shared/note-classification.ts";
import { createDialogue } from "../topics/dialogue.ts";
import { mountComposer } from "../topics/composer.ts";
import { createWorkPanel } from "../topics/work.ts";
import { createApprovals } from "../topics/approvals.ts";
import { mountTopicTabs } from "../topics/tabs.ts";

const lifetime = new AbortController(), signal = lifetime.signal;
let timer: ReturnType<typeof setInterval> | undefined;
let ready = false, polling = false;
const topicId = "gate", query = "?topicId=" + topicId;
const tabs = mountTopicTabs(true, signal, () => { dialogue.pause(); if (tabs.isDialogue()) dialogue.show(); });
const dialogue = createDialogue(topicId, signal, () => ready && timer !== undefined && tabs.isDialogue() && !document.hidden, true);
const work = createWorkPanel(topicId, poll, signal), approvals = createApprovals(poll, signal);
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
    const [works, pending] = await Promise.all([request<Work[]>("/work" + query, { signal }), request<Approval[]>("/approvals" + query, { signal })]);
    if (signal.aborted) return;
    work.render(works); approvals.render(pending); byId("poll-notice").textContent = "";
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
