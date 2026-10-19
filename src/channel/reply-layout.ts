import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false });

/** @why A preview is a bounded excerpt, not a new model summary; each channel keeps the full answer available. */
export function replyPreview(content: string): string {
  const firstLine = content.trim().split("\n", 1)[0] ?? "";
  const inline = markdown.parse(firstLine, {}).find((token) => token.type === "inline");
  const text = inline?.children?.map((token) => token.content).join("").trim() || "回复已完成";
  const points = Array.from(text);
  return points.slice(0, 80).join("") + (points.length > 80 ? "…" : "");
}
