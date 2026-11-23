import type { NoteSpec } from "../../../plugins/personal/note/model.ts";
import { element } from "./dom.ts";

/** @spec Notes and summaries show disclosure and optional knowledge nature below the body; refreshes replace the footer. */
export function renderNoteClassification(container: HTMLElement, note?: Pick<NoteSpec, "sensitivity" | "visibility" | "nature" | "closedAt">): void {
  container.querySelector(":scope > .note-classification")?.remove();
  if (!note) return;
  const sensitivity = note.sensitivity ?? "未定级", visibility = note.visibility ?? "未指定";
  const nature = note.nature;
  const footer = element("div", [sensitivity, visibility, ...(nature ? [nature] : []), ...(note.closedAt ? ["已办结"] : [])].join(" · "), "note-classification");
  footer.setAttribute("aria-label", `敏感度 ${sensitivity}，可见范围 ${visibility}${nature ? `，知识性质 ${nature}` : ""}${note.closedAt ? `，已办结 ${note.closedAt}` : ""}`);
  footer.title = `sensitivity: ${sensitivity}; visibility: ${visibility}${nature ? `; nature: ${nature}` : ""}${note.closedAt ? `; closedAt: ${note.closedAt}` : ""}`;
  container.append(footer);
}
