import { answerPreview, processPreview, replyLabels } from "../reply-layout.ts";

export interface LarkProgress {
  id: string;
  phase: "queued" | "running" | "done" | "failed";
  think: string;
  content: string;
  process?: ReturnType<typeof processPreview>;
  liveAnswer?: string;
  messageIds: string[];
  overflow: boolean;
}
const labels = replyLabels;

/**
 * @spec Stable panels retain reader-owned expansion while text previews change from live progress to completed summaries.
 * @link docs/channel/README.md#回复展示状态
 */
export function progressCard(view: LarkProgress, streaming: boolean) {
  const fields = cardPreviews(view);
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default", streaming_mode: streaming },
    header: { title: { tag: "plain_text", content: "Aide" }, template: "blue" },
    body: { elements: [cardPanel("过程与回答", [
      { tag: "div", element_id: "thought_preview", ...fields.thought_preview },
      { tag: "div", element_id: "tool_preview", ...fields.tool_preview },
      cardPanel("过程 · 查看详情", [{ tag: "markdown", element_id: "think", content: cardThought(view) }], false),
      { tag: "div", element_id: "answer_preview", ...fields.answer_preview },
      cardPanel("回答 · 查看详情", [{ tag: "markdown", element_id: "content", content: cardContent(view) }], false),
    ], true)] },
  };
}

export function cardPreviews(view: LarkProgress) {
  const live = view.phase === "running" || view.phase === "queued";
  const process = view.process ?? processPreview(view.phase, view.think ? [{ type: "thought", content: view.think }] : []);
  return {
    thought_preview: { text: { tag: "plain_text", content: live ? `思考：${process.thought}` : `过程：${process.summary}`, lines: 1 } },
    tool_preview: { text: { tag: "plain_text", content: live ? `工具：${process.tool}` : "", lines: 1 } },
    answer_preview: { text: { tag: "plain_text", content: `回答：${view.phase === "done" && !view.content.trim() ? "暂无对外回复" : view.liveAnswer ?? answerPreview(cardContent(view).trim(), view.phase)}`,
      lines: view.phase === "failed" ? 1000 : 3 } },
  };
}

function cardPanel(title: string, elements: unknown[], expanded: boolean) {
  return { tag: "collapsible_panel", expanded,
    header: { title: { tag: "plain_text", content: title },
      icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" }, icon_expanded_angle: -180 },
    elements };
}

export function cardContent(view: LarkProgress): string {
  return (view.content || (view.phase === "failed" ? "这次处理已中断，请核对后重新交办。" : " "))
    + (view.overflow ? "\n\n（内容较长，完整回复见后续消息。）" : "");
}

export function cardThought(view: LarkProgress): string {
  return view.think || labels[view.phase]!;
}
