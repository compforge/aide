import { sameAddress } from "../address.ts";
import { channelOutputs } from "./output.ts";
import { answerPreview, processPreview, replyLabels } from "./reply-layout.ts";
import type { ChannelService } from "./service.ts";
import { conversationView } from "./view.ts";

export interface LarkProgress {
  id: string;
  phase: "queued" | "running" | "waiting" | "done" | "failed";
  think: string;
  content: string;
  process?: ReturnType<typeof processPreview>;
  liveAnswer?: string;
  messageIds: string[];
  overflow: boolean;
}
export type LarkProgressReader = (conversationId: string) => LarkProgress[];
const labels = replyLabels;

/**
 * @spec Lark reads the same thought/text/tool projection as Web; progress is never persisted as a business Message.
 * @link docs/channel/lark.md
 */
export function larkProgress(aide: ChannelService, conversationId: string): LarkProgress[] {
  const view = conversationView(aide, conversationId);
  const inputs = aide.findConversation(conversationId)?.conversations.inputs(conversationId) ?? [];
  const seen = new Set<string>();
  return inputs.filter((input) => {
    if (input.spec.origin !== "channel" || input.spec.replyTo) return false;
    const group = view.blocks.find((b) => b.inputId === input.metadata.name)?.group_id ?? input.metadata.name;
    if (seen.has(group)) return false;
    seen.add(group); return true;
  }).map((input) => {
    const group = view.blocks.find((b) => b.inputId === input.metadata.name)?.group_id ?? input.metadata.name;
    const executions = view.blocks.filter((block) => block.type === "execution" && block.group_id === group);
    const parents = new Set(executions.map((block) => block.id));
    const blocks = view.blocks.filter((block) => block.parent_id && parents.has(block.parent_id));
    const rawPhase = input.consumption.phase;
    const phase = rawPhase === "compacting" ? "running" : rawPhase === "interrupted" ? "failed" : rawPhase ?? "queued";
    const ids = new Set(view.blocks.filter((b) => b.type === "message" && b.group_id === group).map((b) => b.id.replace(/^message:/, "")));
    // A Conversation may produce Outputs for another destination; a progress card cannot deliver those.
    const address = aide.findConversation(conversationId)?.conversations.resource(conversationId)?.spec.address;
    const addressed = channelOutputs(aide).filter((o) => address && sameAddress(o.target, address));
    const responses = addressed.filter((m) => ids.has(m.id));
    if (phase === "waiting") {
      const question = aide.questions().find((item) => item.conversationId === conversationId && item.request.status === "pending");
      const message = question && addressed.find((item) => item.id === question.request.messageId);
      if (message) responses.push(message);
    }
    const text = responses.map((message) => message.text).join("\n\n");
    const think = blocks.filter((block) => block.type === "thought" || block.type === "tool")
      .map((block) => block.type === "tool" ? `工具：${block.content} · ${block.status ?? "执行中"}` : block.content).join("\n\n");
    const points = Array.from(text), thought = Array.from(think);
    const result: LarkProgress = { id: input.metadata.name, phase, think: thought.length > 2000 ? "（仅展示最近过程，完整记录可在网页查看）\n" + thought.slice(-2000).join("") : think,
      content: points.slice(0, 4000).join(""), overflow: points.length > 4000,
      process: processPreview(phase, blocks),
      liveAnswer: phase === "running" || phase === "queued" ? answerPreview(text, phase) : undefined,
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
    answer_preview: { text: { tag: "plain_text", content: `回答：${view.liveAnswer ?? answerPreview(cardContent(view).trim(), view.phase)}`,
      lines: view.phase === "waiting" || view.phase === "failed" ? 1000 : 3 } },
  };
}

function cardPanel(title: string, elements: unknown[], expanded: boolean) {
  return { tag: "collapsible_panel", expanded,
    header: { title: { tag: "plain_text", content: title },
      icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" }, icon_expanded_angle: -180 },
    elements };
}

export function cardContent(view: LarkProgress): string {
  return (view.content || (view.phase === "failed" ? "这次处理已中断，请核对后重新交办。" : view.phase === "waiting" ? "等待你回答。" : " "))
    + (view.overflow ? "\n\n（内容较长，完整回复见后续消息。）" : "");
}

export function cardThought(view: LarkProgress): string {
  return view.think || labels[view.phase]!;
}
