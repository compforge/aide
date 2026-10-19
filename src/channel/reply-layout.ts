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

export const replyLabels: Record<string, string> = {
  queued: "排队中", running: "正在处理", waiting: "等待你回答", done: "已完成", failed: "处理已中断",
};
export const toolLabels: Record<string, string> = {
  in_progress: "执行中", pending: "等待执行", completed: "已完成", failed: "失败", declined: "已拒绝",
};

/** @spec Preview facts come from the execution projection; active tools take precedence over recently completed tools. */
export function processPreview(phase: string, blocks: readonly { type: string; content: string; status?: string }[]) {
  const thoughts = blocks.filter((block) => block.type === "thought");
  const tools = blocks.filter((block) => block.type === "tool");
  const active = tools.filter((block) => block.status === "in_progress" || block.status === "pending");
  const current = active.at(-1) ?? tools.at(-1);
  const thought = thoughts.at(-1)?.content.trim();
  return {
    thought: thought ? Array.from(replyText(thought)).slice(-160).join("") : replyLabels[phase] ?? "正在处理",
    tool: current ? `${Array.from(current.content.replace(/\s+/g, " ")).slice(0, 160).join("")} · ${toolLabels[current.status ?? ""] ?? current.status ?? "状态未知"}`
      + (active.length > 1 ? ` · 另有 ${active.length - 1} 项待完成` : "") : "尚无工具调用",
    summary: (replyLabels[phase] ?? phase) + (tools.length ? ` · ${tools.length} 次工具调用` : ""),
  };
}

/** @why Feishu clamps from the start, so live previews use a recent excerpt; full Markdown stays in the details. */
export function answerPreview(content: string, phase: string): string {
  if (!content.trim()) return phase === "failed" ? "本次处理已中断，请核对后重新交办。"
    : phase === "waiting" ? "等待你回答。" : phase === "done" ? "回复已完成" : "等待生成回答…";
  const text = replyText(content);
  const points = Array.from(text);
  return (phase === "running" || phase === "queued") && points.length > 120 ? "…" + points.slice(-120).join("") : text;
}
