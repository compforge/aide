import { processPreview, replyLabels } from "../reply-layout.ts";

export interface LarkProgress {
  id: string;
  phase: "queued" | "running" | "done" | "failed";
  think: string;
  content: string;
  processUrl?: string;
  process?: ReturnType<typeof processPreview>;
  messageIds: string[];
  overflow: boolean;
}
const labels = replyLabels;

/**
 * @spec Answer is top-level Markdown and process starts collapsed; later text/header patches preserve reader-owned expansion.
 * @link docs/channel/README.md#回复展示状态
 */
export function progressCard(view: LarkProgress, streaming: boolean) {
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default", streaming_mode: streaming },
    header: { title: { tag: "plain_text", content: "Aide" }, template: "blue" },
    body: { elements: [
      { tag: "markdown" as const, element_id: "content", content: cardContent(view) },
      cardPanel("process_panel", processTitle(view), [{ tag: "markdown", element_id: "think", content: cardThought(view) }], false),
    ] },
  };
}

/** Header patches deliberately omit expanded and child elements. */
export function cardHeaders(view: LarkProgress) {
  return { process_panel: { header: panelHeader(processTitle(view)) } };
}

function processTitle(view: LarkProgress): string {
  const process = view.process ?? processPreview(view.phase, view.think ? [{ type: "thought", content: view.think }] : []);
  return `查看过程 · ${process.summary}`;
}
function panelHeader(title: string) {
  return { title: { tag: "plain_text", content: title },
    icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" }, icon_expanded_angle: -180 };
}
function cardPanel<T>(id: string, title: string, elements: T[], expanded: boolean) {
  return { tag: "collapsible_panel", element_id: id, expanded, header: panelHeader(title), elements };
}

export function cardContent(view: LarkProgress): string {
  return (view.content || (view.phase === "failed" ? "这次处理已中断，请核对后重新交办。" : view.phase === "done" ? "暂无对外回复。" : "等待生成回答…"))
    + (view.phase === "failed" && view.content ? "\n\n这次处理已中断，请核对后重新交办。" : "")
    + (view.overflow ? "\n\n（内容较长，完整回复见后续消息。）" : "");
}

export function cardThought(view: LarkProgress): string {
  return (view.think || labels[view.phase]!) + (view.processUrl ? `\n\n[在 Web 查看完整过程](${view.processUrl})` : "");
}
