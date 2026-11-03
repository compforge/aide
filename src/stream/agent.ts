import type { StreamEvent, StreamReader, StreamStatus } from "@compforge/aide-plugin";
import { textOf, type EventPayloadMap, type ContentBlock } from "../host/event/index.ts";

export const AGENT_STREAM_PROTOCOL = "aide.agent/v1";
export const agentStreamKinds = ["agent_message", "agent_message_chunk", "agent_thought", "agent_thought_chunk", "tool_call_update", "tool_call_content_chunk"] as const;
type Kind = typeof agentStreamKinds[number];
export type AgentStreamEvent = { [K in Kind]: { kind: K; payload: EventPayloadMap[K] } }[Kind];
export const textEvent = (text: string, messageId = "answer"): AgentStreamEvent => ({ kind: "agent_message", payload: { messageId, phase: "final", content: [{ type: "text", text }] } });
interface Message { id: string; kind: "think" | "text"; content: ContentBlock[]; phase?: string }
export type StreamTool = Omit<EventPayloadMap["tool_call_update"], "content"> & { content: ContentBlock[] };
interface Projection { seq: number; messages: Map<string, Message>; tools: Map<string, StreamTool> }
export interface AgentStreamView extends StreamStatus { think: string; text: string; tools: StreamTool[] }
const caches = new WeakMap<object, Map<string, Projection>>();
/** @spec Record order is append-only; message upserts preserve the Harness replace/clear/omitted semantics.
 * @spec Only content consumers interpret agent events. Output delivery passes an opaque read handle.
 * @link docs/plugin/stream.md
 */
export function readAgentStream(reader: StreamReader, cacheOwner?: object): AgentStreamView {
  if (reader.protocol !== AGENT_STREAM_PROTOCOL) throw new Error(`Unsupported mail protocol: ${reader.protocol}`);
  let cache = cacheOwner && caches.get(cacheOwner);
  if (cacheOwner && !cache) { cache = new Map(); caches.set(cacheOwner, cache); }
  let state = cache?.get(reader.ref.uid);
  if (!state || state.seq > reader.status.lastSeq) state = { seq: 0, messages: new Map(), tools: new Map() };
  while (state.seq < reader.status.lastSeq) {
    const batch = reader.read(state.seq);
    if (!batch.length) throw new Error(`Stream tail is missing: ${reader.ref.uid}`);
    for (const record of batch) { apply(state, record); state.seq = record.seq; }
  }
  if (cache) {
    cache.delete(reader.ref.uid); cache.set(reader.ref.uid, state);
    if (cache.size > 128) cache.delete(cache.keys().next().value!);
  }
  const messages = [...state.messages.values()];
  return { ...reader.status, think: messages.filter(m => m.kind === "think").map(m => textOf(m.content)).filter(Boolean).join("\n\n"),
    text: messages.filter(m => m.kind === "text").map(m => textOf(m.content)).filter(Boolean).join("\n\n"), tools: [...state.tools.values()].map(tool => ({ ...tool, content: [...tool.content] })) };
}
function apply(state: Projection, event: StreamEvent) {
  if (!(agentStreamKinds as readonly string[]).includes(event.kind)) throw new Error(`Unknown agent mail record: ${event.kind}`);
  const record = event as AgentStreamEvent;
  if (record.kind === "tool_call_update" || record.kind === "tool_call_content_chunk") {
    const p = record.payload, tool = state.tools.get(p.toolCallId) ?? { toolCallId: p.toolCallId, content: [] };
    if (record.kind === "tool_call_content_chunk") tool.content.push(record.payload.content);
    else { const { content, ...patch } = record.payload; Object.assign(tool, patch); if (content !== undefined) tool.content = content ?? []; }
    state.tools.set(p.toolCallId, tool); return;
  }
  const p = record.payload, kind = record.kind.startsWith("agent_thought") ? "think" : "text";
  const key = `${kind}:${p.messageId}`, message = state.messages.get(key) ?? { id: p.messageId, kind, content: [] };
  if (record.kind === "agent_message_chunk" || record.kind === "agent_thought_chunk") message.content.push(record.payload.content);
  else { if (record.payload.content !== undefined) message.content = record.payload.content ?? [];
    if (record.kind === "agent_message" && record.payload.phase !== undefined) message.phase = record.payload.phase; }
  state.messages.set(key, message);
}
