import type { TopicView } from "../../channel/view.ts";
import { byId, element } from "../shared/dom.ts";
import { updateMarkdown } from "../shared/markdown.ts";

export function createTopicContextPanel() {
  let previous: string | undefined;
  function render(context: TopicView["meta"]["context"]) {
    const signature = JSON.stringify(context);
    if (signature === previous) return;
    previous = signature;
    const summary = byId("topic-summary");
    const text = context?.summary.trim() ?? "";
    updateMarkdown(summary, text || "尚未形成话题摘要。");
    summary.classList.toggle("muted", !text);
    const recent = byId("topic-recent");
    recent.replaceChildren();
    if (!context?.recent.length) recent.append(element("p", "暂无近期记录。", "muted"));
    for (const entry of [...(context?.recent ?? [])].reverse()) {
      const item = element("article", undefined, "context-entry");
      const time = element("time", new Date(entry.at).toLocaleString(), "muted");
      time.dateTime = entry.at;
      const content = element("div", undefined, "markdown");
      updateMarkdown(content, entry.text);
      item.append(time, content);
      recent.append(item);
    }
  }
  return { render };
}
