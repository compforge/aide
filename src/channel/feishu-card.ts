import { replyText } from "./reply-layout.ts";
import type { ChannelService } from "./service.ts";
import { conversationView } from "./view.ts";

export interface FeishuProgress {
  id: string;
  phase: "queued" | "running" | "waiting" | "done" | "failed";
  think: string;
  content: string;
  messageIds: string[];
  overflow: boolean;
}
export type FeishuProgressReader = (conversationId: string) => FeishuProgress[];
const labels = { queued: "排队中", running: "正在处理", waiting: "等待你回答", done: "已完成", failed: "处理已中断" };

/**
 * @spec Feishu reads the same thought/text/tool projection as Web; progress is never persisted as a business Message.
 * @link docs/channel/feishu.md
 */
export function feishuProgress(aide: ChannelService, conversationId: string): FeishuProgress[] {
  const view = conversationView(aide, conversationId);
  const inputs = aide.findConversation(conversationId)?.conversations.inputs(conversationId) ?? [];
  return inputs.filter((input) => input.spec.origin === "channel" && !input.spec.replyTo).map((input) => {
    const turnIds = new Set(aide.invocations().filter((turn) => turn.inputId === input.metadata.name).map((turn) => `execution:${turn.turnId}`));
    const executions = view.blocks.filter((block) => block.type === "execution" &&
      (turnIds.has(block.id) || (!input.status.laneId && view.meta.activity?.id === input.metadata.name && block.status === "running")));
    const parents = new Set(executions.map((block) => block.id));
    const blocks = view.blocks.filter((block) => block.parent_id && parents.has(block.parent_id));
    const phase = input.status.phase ?? "queued";
    const responses = (input.status.messages ?? []).filter((message) => message.role === "aide");
    if (phase === "waiting") {
      const question = aide.questions().find((item) => item.conversationId === conversationId && item.request.status === "pending");
      const message = question && aide.messages().find((item) => item.id === question.request.messageId);
      if (message) responses.push(message);
    }
    const text = responses.map((message) => message.text).join("\n\n") || blocks.filter((block) => block.type === "text").at(-1)?.content || "";
    const think = blocks.filter((block) => block.type === "thought" || block.type === "tool")
      .map((block) => block.type === "tool" ? `工具：${block.content} · ${block.status ?? "执行中"}` : block.content).join("\n\n");
    const points = Array.from(text), thought = Array.from(think);
    const result: FeishuProgress = { id: input.metadata.name, phase, think: thought.length > 2000 ? "（仅展示最近过程，完整记录可在网页查看）\n" + thought.slice(-2000).join("") : think,
      content: points.slice(0, 4000).join(""), overflow: points.length > 4000,
      messageIds: responses.map((message) => message.id) };
    // Include the nested JSON escaping of the CardKit envelope in the size budget.
    while (Buffer.byteLength(JSON.stringify({ type: "card_json", data: JSON.stringify(progressCard(result, false)) })) > 28_000) {
      if (Array.from(result.think).length > 500) result.think = Array.from(result.think).slice(-500).join("");
      else { result.content = Array.from(result.content).slice(0, Math.floor(Array.from(result.content).length / 2)).join(""); result.overflow = true; }
    }
    return result;
  });
}

/**
 * @spec One reply has a collapsible outer envelope and independent thought/answer panels; completed replies show a three-line answer preview above collapsed details.
 * @why Finished cards should not crowd the chat while retaining the full Markdown reply in the same message.
 * @link docs/channel/feishu.md
 */
export function progressCard(view: FeishuProgress, streaming: boolean) {
  const thought = { tag: "markdown", element_id: "think", content: cardThought(view) };
  const content = { tag: "markdown", element_id: "content", content: cardContent(view) };
  const compact = !streaming && view.phase === "done";
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default", streaming_mode: streaming,
      summary: { content: streaming ? "Aide · 处理中" : view.content.slice(0, 100) || labels[view.phase] } },
    header: { title: { tag: "plain_text", content: `Aide · ${labels[view.phase]}` }, template: view.phase === "failed" ? "orange" : "blue" },
    body: { elements: [
      ...(compact ? [{ tag: "div", text: { tag: "plain_text", content: replyText(view.content), lines: 3 } }] : []),
      cardPanel(compact ? "查看完整回复" : "思考与回答", [
        cardPanel("思考与执行过程", [thought], false), cardPanel("回答", [content], true),
      ], !compact),
    ] },
  };
}

function cardPanel(title: string, elements: unknown[], expanded: boolean) {
  return { tag: "collapsible_panel", expanded,
    header: { title: { tag: "plain_text", content: title },
      icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" }, icon_expanded_angle: -180 },
    elements };
}

export function cardContent(view: FeishuProgress): string {
  return (view.content || (view.phase === "failed" ? "这次处理已中断，请核对后重新交办。" : view.phase === "waiting" ? "等待你回答。" : " "))
    + (view.overflow ? "\n\n（内容较长，完整回复见后续消息。）" : "");
}

export function cardThought(view: FeishuProgress): string {
  return view.think || labels[view.phase];
}
