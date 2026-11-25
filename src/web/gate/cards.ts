import type { GateNoteItem, GateWorkItem } from "../../../plugins/personal/gate/browse.ts";
import { element } from "../shared/dom.ts";
import { workStatusLabels } from "../shared/work-status.ts";

const summaries = {
  Topic: ["主题", "M5 7v11h5 M5 11h5 M3 3h4v4H3z M11 9h4v4h-4z M11 16h4v4h-4z"],
  Person: ["人物", "M14 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z M3 20v-2a7 7 0 0 1 14 0v2"],
  Address: ["地址", "M5 3h12v16H5z M3 6h3 M3 11h3 M3 16h3 M9 8h5 M9 12h5"],
  Task: ["事项", "M4 4h13v15H4z M7 11l3 3 5-6"],
  Routine: ["安排", "M3 10a7 7 0 0 1 12-5l2 2 M17 3v4h-4 M17 12a7 7 0 0 1-12 5l-2-2 M3 19v-4h4"],
} as const;

function summaryIcon(kind: keyof typeof summaries, owner: string) {
  const [label, path] = summaries[kind];
  const icon = element("span", undefined, "summary-icon");
  const description = owner + "的" + label + "摘要";
  icon.tabIndex = 0;
  icon.setAttribute("role", "img");
  icon.setAttribute("aria-label", description);
  icon.dataset.tooltip = description;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 22 22");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS(svg.namespaceURI, "path");
  shape.setAttribute("d", path); svg.append(shape); icon.append(svg);
  return icon;
}

function link(label: string, href: string) {
  const node = element("a", label); node.href = href; return node;
}
const topicUrl = (id: string) => id === "gate" ? "/gate" : "/?" + new URLSearchParams({ topic: id });

export function noteCard(item: GateNoteItem) {
  const card = element("article", undefined, "work gate-note");
  const heading = element("div", undefined, "note-heading");
  if (item.summaryKind) heading.append(summaryIcon(item.summaryKind, item.ownerName));
  heading.append(link(item.title, "/gate?" + new URLSearchParams({ note: item.uid })));
  const meta = element("div", undefined, "gate-meta");
  const { name, uid, kind } = item.subject;
  let href = item.topicId && topicUrl(item.topicId);
  if (item.ownerAvailable && kind === "Person") href = "/people?" + new URLSearchParams({ person: name, uid });
  if (item.ownerAvailable && kind === "Address") href = "/addresses?" + new URLSearchParams({ name, uid });
  meta.append(element("span", item.nature ?? "未分类"), href ? link(item.ownerName, href) : element("span", item.ownerName),
    element("time", new Date(item.updatedAt).toLocaleString()));
  card.append(heading, meta); return card;
}

const kinds = { ongoing: "Ongoing", task: "Task", routine: "Routine" };
export function workCard(item: GateWorkItem, openSupplement: (id: string, title: string) => void) {
  const card = element("article", undefined, "work");
  const header = element("div", undefined, "work-header");
  header.append(element("strong", item.title));
  if (item.kind === "ongoing" && item.status === "open") {
    const supplement = element("button", "补充");
    supplement.type = "button"; supplement.setAttribute("aria-label", "补充 " + item.title);
    supplement.addEventListener("click", () => openSupplement(item.id, item.title));
    header.append(supplement);
  }
  const meta = element("div", undefined, "gate-meta");
  meta.append(element("span", kinds[item.kind]), element("span", workStatusLabels[item.status]));
  if (item.topicId) meta.append(link(item.topicName || item.topicId, topicUrl(item.topicId)));
  card.append(header, meta);
  if (item.kind === "ongoing") {
    if (item.question) card.append(element("p", "待核实：" + item.question));
    if (item.progress) card.append(element("p", "进展：" + item.progress));
    if (item.checkAt) card.append(element("p", "下次核实：" + new Date(item.checkAt).toLocaleString(), "muted"));
    if (item.outcome) card.append(element("p", "结论：" + item.outcome));
  } else {
    card.append(element("p", item.instruction));
    if (item.question) card.append(element("p", item.question));
    if (item.progress) card.append(element("p", "最近办理：" + item.progress));
    if (item.nextAt) card.append(element("p", "下次：" + new Date(item.nextAt).toLocaleString(), "muted"));
  }
  return card;
}
