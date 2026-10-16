import { randomUUID } from "node:crypto";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { HarnessAdapter, HarnessEventSink, HarnessSessionBindingSink, HarnessSessionHandle,
  NativeEventSink, OpenOptions, PromptInput, SendTurnReceipt } from "../adapter.ts";
import { unsupportedPromptBlocks } from "../adapter.ts";
import type { LogSink } from "../../logging.ts";

/** The composition root binds tools; the adapter only speaks Pi's session API. */
export type PiSession = Pick<AgentSession, "sessionId" | "sessionFile" | "subscribe" | "prompt" | "abort" | "dispose">;
export type PiSessionFactory = (options: { cwd: string; sessionFile?: string }) => Promise<PiSession>;
interface Turn {
  id: string; done?: Promise<void>; cancelled: boolean;
  lastMessage?: { id: string; text: string; stop: string; error?: string };
  settled?: { reason: "end_turn" | "error" | "cancelled"; error?: string };
}
interface Session {
  native: PiSession; sink: HarnessEventSink; unsubscribe: () => void; active?: Turn;
}

/**
 * @spec Every accepted turn terminates once, after Pi settles or rejects. Tool-loop messages never become finalText.
 * @link docs/pi.md
 */
export class PiAdapter implements HarnessAdapter {
  readonly harness = "pi";
  readonly capabilities = { prompt: {} };
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly options: { createSession: PiSessionFactory; log?: LogSink; nativeEvent?: NativeEventSink }) {}

  async open(options: OpenOptions, sink: HarnessEventSink, binding: HarnessSessionBindingSink): Promise<HarnessSessionHandle> {
    if (options.env && Object.keys(options.env).length) throw new Error("Embedded Pi does not support per-session environment overrides");
    let sessionFile: string | undefined;
    if (options.resumeState) {
      const data = options.resumeState.data as { sessionFile?: unknown } | null;
      if (options.resumeState.version !== 1 || typeof data?.sessionFile !== "string" || !data.sessionFile) throw new Error("Unsupported Pi resume state");
      sessionFile = data.sessionFile;
    } else if (options.resumeSessionId) throw new Error("Pi resume requires its native session file");
    const native = await this.options.createSession({ cwd: options.cwd, ...(sessionFile ? { sessionFile } : {}) });
    const handleId = randomUUID();
    const session: Session = { native, sink, unsubscribe: () => {} };
    try {
      if (!native.sessionFile) throw new Error("PiAdapter requires a persistent native session");
      session.unsubscribe = native.subscribe((event) => this.observe(session, event));
      binding({ identity: { id: native.sessionId }, resumeState: { version: 1, data: { sessionFile: native.sessionFile } } });
      this.sessions.set(handleId, session);
    } catch (error) { session.unsubscribe(); native.dispose(); throw error; }
    return { harness: this.harness, handleId, resumed: !!sessionFile };
  }

  async sendTurn(ref: HarnessSessionHandle, input: PromptInput): Promise<SendTurnReceipt> {
    const session = this.require(ref);
    if (session.active) return { accepted: false, effective: "rejected", reason: "Pi session is busy; queue a follow-up" };
    const blocks = [...(input.syncBlocks ?? []), ...input.blocks];
    const unsupported = unsupportedPromptBlocks(blocks, this.capabilities);
    if (unsupported.length) throw new Error(`Pi does not support prompt blocks: ${unsupported.join(", ")}`);
    const text = blocks.map((block) => block.type === "text" ? block.text : "").join("\n");
    const turn: Turn = { id: input.turnId, cancelled: false };
    session.active = turn;
    this.log("Pi turn accepted", turn.id);
    // Admission precedes execution; subsequent failures must reach the event stream.
    turn.done = Promise.resolve().then(() => {
      if (!turn.cancelled) return session.native.prompt(text, { expandPromptTemplates: false });
    }).then(() => {
      // Pi emits agent_settled before unwinding its prompt stack. Release the binding only after both boundaries.
      if (session.active === turn) this.finish(session, turn.cancelled ? "cancelled" : turn.settled?.reason ?? "error",
        turn.settled?.error ?? "Pi ended without a settled answer");
    }, (error: unknown) => {
      if (session.active === turn) this.finish(session, turn.cancelled ? "cancelled" : "error", error instanceof Error ? error.message : String(error));
    });
    return { accepted: true, effective: "new_turn" };
  }

  async cancel(ref: HarnessSessionHandle): Promise<void> {
    const session = this.require(ref);
    const turn = session.active;
    if (!turn) return;
    turn.cancelled = true;
    await session.native.abort();
    await turn.done;
  }

  async close(ref: HarnessSessionHandle): Promise<void> {
    const session = this.sessions.get(ref.handleId);
    if (!session) return;
    try { await this.cancel(ref); }
    finally { session.unsubscribe(); session.native.dispose(); this.sessions.delete(ref.handleId); }
  }

  private require(ref: HarnessSessionHandle): Session {
    const session = ref.harness === this.harness ? this.sessions.get(ref.handleId) : undefined;
    if (!session) throw new Error(`Unknown Pi session: ${ref.handleId}`);
    return session;
  }

  private observe(session: Session, event: AgentSessionEvent): void {
    this.options.nativeEvent?.({ direction: "in", name: event.type, payload: event });
    const turn = session.active;
    if (!turn) return;
    if (event.type === "message_end" && event.message.role === "assistant") {
      const previous = turn.lastMessage;
      if (previous?.text) session.sink({ kind: "agent_message", turnId: turn.id,
        payload: { messageId: previous.id, phase: "commentary", content: [{ type: "text", text: previous.text }] } });
      const message = event.message;
      turn.lastMessage = { id: randomUUID(), text: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
        stop: message.stopReason, error: message.errorMessage };
      if (turn.lastMessage.text) session.sink({ kind: "agent_message", turnId: turn.id,
        payload: { messageId: turn.lastMessage.id, content: [{ type: "text", text: turn.lastMessage.text }] } });
      session.sink({ kind: "usage_update", turnId: turn.id, payload: { inputTokens: message.usage.input,
        outputTokens: message.usage.output, cacheReadTokens: message.usage.cacheRead, cacheWriteTokens: message.usage.cacheWrite } });
    } else if (event.type === "tool_execution_start") {
      session.sink({ kind: "tool_call_update", turnId: turn.id, payload: { toolCallId: event.toolCallId,
        title: event.toolName, status: "in_progress", rawInput: event.args } });
    } else if (event.type === "tool_execution_end") {
      session.sink({ kind: "tool_call_update", turnId: turn.id, payload: { toolCallId: event.toolCallId,
        title: event.toolName, status: event.isError ? "failed" : "completed", rawOutput: event.result } });
    } else if (event.type === "agent_settled") {
      if (turn.cancelled || event.aborted || turn.lastMessage?.stop === "aborted") turn.settled = { reason: "cancelled" };
      else if (turn.lastMessage?.stop === "stop" && turn.lastMessage.text.trim()) turn.settled = { reason: "end_turn" };
      else turn.settled = { reason: "error", error: turn.lastMessage?.error ?? `Pi settled without a complete answer (${turn.lastMessage?.stop ?? "no assistant message"})` };
    }
  }

  private finish(session: Session, reason: "end_turn" | "error" | "cancelled", error?: string): void {
    const turn = session.active;
    if (!turn) return;
    session.active = undefined;
    if (reason === "end_turn" && turn.lastMessage) session.sink({ kind: "agent_message", turnId: turn.id,
      payload: { messageId: turn.lastMessage.id, phase: "final", content: [{ type: "text", text: turn.lastMessage.text }] } });
    if (reason === "error") session.sink({ kind: "_aide_error_update", turnId: turn.id,
      payload: { code: "pi_execution_failed", message: error ?? "Pi execution failed", retryable: false, willRetry: false } });
    this.log("Pi turn settled", turn.id, reason);
    session.sink({ kind: "state_update", turnId: turn.id, payload: { state: "idle", stopReason: reason } });
  }

  private log(message: string, turnId: string, reason?: string): void {
    this.options.log?.({ level: reason === "error" ? "error" : "info", source: "harness", component: "pi.adapter",
      harness: "pi", message, turnId, ...(reason ? { attributes: { reason } } : {}) });
  }
}
