import type { StreamReader, StreamStatus, StreamRecord } from "@compforge/aide-plugin";
import { AGENT_STREAM_PROTOCOL } from "../src/stream/agent.ts";
/** Channel unit tests supply protocol records; integration tests exercise the durable store. */
export function mailReader(phase: StreamStatus["phase"], revision = 1, think = "", text = "", uid = "mail"): StreamReader {
  const records: StreamRecord[] = [
    { seq: revision * 2 - 1, kind: "agent_thought", payload: { messageId: "thought", content: [{ type: "text", text: think }] } },
    { seq: revision * 2, kind: "agent_message", payload: { messageId: "reply", content: [{ type: "text", text }] } },
  ];
  return { ref: { apiVersion: "aide.dev/v1alpha1", kind: "Stream", namespace: "v1", name: uid, uid }, protocol: AGENT_STREAM_PROTOCOL,
    status: { phase, lastSeq: revision * 2, references: [], ...(phase === "open" ? {} : { closedAt: new Date(0).toISOString() }) },
    read: after => records.filter(r => r.seq > (after ?? 0)) };
}
