import type { MaterialDisclosure } from "../../../plugins/personal/disclosure.ts";
import { element } from "./dom.ts";

/** @spec Notes and summaries show their classification below the body; refreshes replace the footer rather than duplicating it. */
export function renderNoteClassification(container: HTMLElement, note?: MaterialDisclosure): void {
  container.querySelector(":scope > .note-classification")?.remove();
  if (!note) return;
  const sensitivity = note.sensitivity ?? "未定级", visibility = note.visibility ?? "未指定";
  const footer = element("div", `${sensitivity} · ${visibility}`, "note-classification");
  footer.setAttribute("aria-label", `敏感度 ${sensitivity}，可见范围 ${visibility}`);
  footer.title = `sensitivity: ${sensitivity}; visibility: ${visibility}`;
  container.append(footer);
}
