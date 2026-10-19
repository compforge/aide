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

/** @why Native line clamping needs readable text across the answer, without Markdown syntax or a first-line cutoff. */
export function replyText(content: string): string {
  return markdown.parse(content, {}).flatMap((token) => {
    if (token.type === "inline") return [token.children?.map((child) =>
      child.type === "softbreak" || child.type === "hardbreak" ? " " : child.content).join("") ?? ""];
    if (token.type === "fence" || token.type === "code_block") return [token.content];
    return [];
  }).join(" ").replace(/\s+/g, " ").trim() || "回复已完成";
}
