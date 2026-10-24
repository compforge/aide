import { randomUUID } from "node:crypto";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  Harness, HarnessEventSink, SessionReferenceSink, HarnessSessionHandle,
  NativeEventSink, OpenOptions, PromptInput, SendTurnReceipt
} from "../adapter.ts";
import { unsupportedPromptBlocks } from "../adapter.ts";
import type { LogSink } from "../../logging.ts";

/** The composition root binds tools; the adapter only speaks Pi's session API. */
export type PiSession = Pick<AgentSession, "sessionId" | "sessionFile" | "subscribe" | "prompt" | "abort" | "dispose" | "bindExtensions" | "extensionRunner"> & Partial<Pick<AgentSession, "steer" | "followUp" | "clearQueue">>;
export type PiSessionFactory = (options: { cwd: string; sessionId?: string }) => Promise<PiSession>;
interface Turn {
  steering: Map<string, string>;
  admissions: Set<Promise<unknown>>;
  closing?: boolean;
  compactionFailure?: string;
  id: string; done?: Promise<void>; cancelled: boolean;
  streaming?: { messageId: string; thoughtId: string };
  lastMessage?: { id: string; text: string; stop: string; error?: string };
  settled?: { reason: "end_turn" | "error" | "cancelled"; error?: string };
}
interface Session {
  native: PiSession; sink: HarnessEventSink; unsubscribe: () => void; active?: Turn;
  binding: SessionReferenceSink;
}

/**
 * @spec Every accepted turn terminates once, after Pi settles or rejects. Tool-loop messages never become finalText.
 * @link docs/harness/pi.md
 */
export class PiAdapter implements Harness {
  readonly harness: "pi" | "chief" | "route" | "weave" | "task" | "routine";
  readonly capabilities = { prompt: {} };
  readonly steering = { deliveryTracking: "explicit", cancelOwnership: "survives" } as const;
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly options: { harness?: "pi" | "chief" | "route" | "weave" | "task" | "routine"; createSession: PiSessionFactory; log?: LogSink; nativeEvent?: NativeEventSink }) {
    this.harness = options.harness ?? "pi";
  }


  create(options: OpenOptions, sink: HarnessEventSink, reference: SessionReferenceSink): Promise<HarnessSessionHandle> {
    if (options.sessionId) throw new Error("Use resume to restore an existing session");
    return this.open(options, sink, reference);
  }

  resume(options: OpenOptions & { sessionId: string }, sink: HarnessEventSink, reference: SessionReferenceSink): Promise<HarnessSessionHandle> {
    return this.open(options, sink, reference);
  }

  prompt(ref: HarnessSessionHandle, input: PromptInput): Promise<SendTurnReceipt> {
    return this.sendTurn(ref, input);
  }

  steer(ref: HarnessSessionHandle, input: PromptInput): Promise<SendTurnReceipt> {
    return this.sendTurn(ref, input, "steer");
  }

  followUp(ref: HarnessSessionHandle, input: PromptInput): Promise<SendTurnReceipt> {
    return this.sendTurn(ref, input, "followUp");
  }
  private async open(options: OpenOptions, sink: HarnessEventSink, binding: SessionReferenceSink): Promise<HarnessSessionHandle> {
    if (options.env && Object.keys(options.env).length) throw new Error("Embedded Pi does not support per-session environment overrides");
    const native = await this.options.createSession({ cwd: options.cwd, ...(options.sessionId ? { sessionId: options.sessionId } : {}) });
    const handleId = randomUUID();
    const session: Session = { native, sink, binding, unsubscribe: () => {} };
    try {
      if (!native.sessionFile) throw new Error("PiAdapter requires a persistent native session");
      if (options.sessionId && native.sessionId !== options.sessionId) throw new Error("Pi session ID does not match its recovery locator");
      session.unsubscribe = native.subscribe((event) => this.observe(session, event));
      const startupErrors: string[] = [];
      let starting = true;
      await native.bindExtensions({ mode: "rpc", onError: (error) => {
        if (starting) startupErrors.push(`${error.extensionPath}: ${error.error}`);
        this.options.log?.({ level: "error", source: "harness", component: "pi.extension", harness: this.harness,
          message: "Pi extension failed", error: { message: error.error },
          attributes: { extension: error.extensionPath, event: error.event ?? "unknown", sessionId: native.sessionId } });
      } });
      starting = false;
      if (startupErrors.length) throw new Error(`Pi extension startup failed: ${startupErrors.join("; ")}`);
      this.options.log?.({ level: "info", source: "harness", component: "pi.extension", harness: this.harness,
        message: "Pi extensions started", attributes: { sessionId: native.sessionId } });
      this.publishBinding(session);
      this.sessions.set(handleId, session);
    } catch (error) {
      try { await native.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
      finally { session.unsubscribe(); native.dispose(); }
      throw error;
    }
    return { harness: this.harness, handleId, resumed: !!options.sessionId };
  }

  private async sendTurn(ref: HarnessSessionHandle, input: PromptInput, operation: "prompt" | "steer" | "followUp" = "prompt"): Promise<SendTurnReceipt> {
    const session = this.require(ref);
    const blocks = input.blocks;
    const unsupported = unsupportedPromptBlocks(blocks, this.capabilities);
    if (unsupported.length) throw new Error(`Pi does not support prompt blocks: ${unsupported.join(", ")}`);
    const text = blocks.map((block) => block.type === "text" ? block.text : "").join("\n");
    if (session.active) {
      const turn = session.active;
      if (operation === "prompt" || turn.id !== input.invocationId || turn.cancelled || turn.compactionFailure || turn.settled || turn.closing || !session.native[operation] || !session.native.clearQueue) {
        return { accepted: false, effective: "rejected", reason: "Pi cannot accept this operation in the current invocation" };
      }
      const marker = `[aide-input:${input.messageId}]`;
      turn.steering.set(input.messageId, marker);
      const admission = session.native[operation]!(`${marker}\n${text}`);
      turn.admissions.add(admission);
      try {
        const receipt = await admission;
        if (receipt !== "queued") { turn.steering.delete(input.messageId); return { accepted: false, effective: "rejected", reason: "Pi input handler did not queue the steer" }; }
        return { accepted: true, effective: operation };
      } catch (error) { turn.steering.delete(input.messageId); throw error; }
      finally { turn.admissions.delete(admission); }
    }
    if (operation !== "prompt") return { accepted: false, effective: "rejected", reason: "not_running" };
    const turn: Turn = { id: input.invocationId, cancelled: false, steering: new Map(), admissions: new Set() };
    session.active = turn;
    this.log("Pi turn accepted", turn.id);
    // Admission precedes execution; subsequent failures must reach the event stream.
    turn.done = Promise.resolve().then(() => {
      if (!turn.cancelled) return session.native.prompt(text, { expandPromptTemplates: false });
    }).then(() => {
      // Pi emits agent_settled before unwinding its prompt stack. Release the binding only after both boundaries.
      if (session.active === turn) return this.finish(session, turn.cancelled ? "cancelled" : turn.settled?.reason ?? "error",
        turn.settled?.error ?? "Pi ended without a settled answer");
    }, (error: unknown) => {
      if (session.active === turn) return this.finish(session, turn.cancelled ? "cancelled" : "error", error instanceof Error ? error.message : String(error));
    });
    return { accepted: true, effective: "new_turn" };
  }

  async abort(ref: HarnessSessionHandle): Promise<void> {
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
    try { await this.abort(ref); }
    finally {
      // @spec Extensions finish persistence and release resources before their native context is disposed.
      try { await session.native.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
      finally { session.unsubscribe(); session.native.dispose(); this.sessions.delete(ref.handleId); }
    }
  }

  private require(ref: HarnessSessionHandle): Session {
    const session = ref.harness === this.harness ? this.sessions.get(ref.handleId) : undefined;
    if (!session) throw new Error(`Unknown Pi session: ${ref.handleId}`);
    return session;
  }

  private observe(session: Session, event: AgentSessionEvent): void {
    this.options.nativeEvent?.({ direction: "in", name: event.type, payload: event });
    const turn = session.active;
    if (event.type === "compaction_end") {
      this.options.log?.({ level: event.errorMessage ? "error" : event.aborted ? "warn" : "info",
        source: "harness", component: "pi.adapter", harness: this.harness, invocationId: turn?.id,
        message: event.errorMessage ? "Pi compaction failed" : event.aborted ? "Pi compaction aborted" : "Pi compaction completed",
        ...(event.errorMessage ? { error: { message: event.errorMessage } } : {}),
        attributes: { sessionId: session.native.sessionId, reason: event.reason, willRetry: event.willRetry,
          ...(event.result ? { tokensBefore: event.result.tokensBefore, summaryChars: event.result.summary.length,
            ...(event.result.estimatedTokensAfter === undefined ? {} : { tokensAfter: event.result.estimatedTokensAfter }) } : {}) } });
      // @spec A failed compaction ends this invocation, not the native session. Pi owns subsequent recovery.
      // @why Do not continue this failed turn or permanently reject independent future inputs.
      if (event.errorMessage && turn && !turn.compactionFailure) {
        turn.compactionFailure = `Pi compaction failed: ${event.errorMessage}`;
        void session.native.abort().catch(() => {});
      }
    }
    if (!turn) return;
    if (event.type === "message_start" && event.message.role === "user") {
      const text = typeof event.message.content === "string" ? event.message.content : event.message.content.filter(p => p.type === "text").map(p => p.text).join("\n");
      for (const [messageId, marker] of turn.steering) if (text.includes(marker)) {
        turn.steering.delete(messageId);
        session.sink({ kind: "input_delivery_update", invocationId: turn.id, payload: { messageId, state: "applied" } });
      }
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      const previous = turn.lastMessage;
      if (previous?.text) session.sink({ kind: "agent_message", invocationId: turn.id,
        payload: { messageId: previous.id, phase: "commentary", content: [{ type: "text", text: previous.text }] } });
      turn.streaming = { messageId: randomUUID(), thoughtId: randomUUID() };
    } else if (event.type === "message_update" && event.message.role === "assistant") {
      const delta = event.assistantMessageEvent;
      if (delta.type !== "text_delta" && delta.type !== "thinking_delta") return;
      const ids = turn.streaming ??= { messageId: randomUUID(), thoughtId: randomUUID() };
      session.sink({ kind: delta.type === "text_delta" ? "agent_message_chunk" : "agent_thought_chunk", invocationId: turn.id,
        payload: { messageId: delta.type === "text_delta" ? ids.messageId : ids.thoughtId, content: { type: "text", text: delta.delta } } });
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message;
      const ids = turn.streaming ?? { messageId: randomUUID(), thoughtId: randomUUID() };
      turn.streaming = undefined;
      const thought = message.content.filter((part) => part.type === "thinking").map((part) => part.thinking).join("\n");
      if (thought) session.sink({ kind: "agent_thought", invocationId: turn.id,
        payload: { messageId: ids.thoughtId, content: [{ type: "text", text: thought }] } });
      turn.lastMessage = { id: ids.messageId, text: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
        stop: message.stopReason, error: message.errorMessage };
      if (turn.lastMessage.text) session.sink({ kind: "agent_message", invocationId: turn.id,
        payload: { messageId: turn.lastMessage.id, content: [{ type: "text", text: turn.lastMessage.text }] } });
      session.sink({ kind: "usage_update", invocationId: turn.id, payload: { inputTokens: message.usage.input,
        outputTokens: message.usage.output, cacheReadTokens: message.usage.cacheRead, cacheWriteTokens: message.usage.cacheWrite } });
    } else if (event.type === "tool_execution_start") {
      session.sink({ kind: "tool_call_update", invocationId: turn.id, payload: { toolCallId: event.toolCallId,
        title: event.toolName, status: "in_progress", rawInput: event.args } });
    } else if (event.type === "tool_execution_end") {
      session.sink({ kind: "tool_call_update", invocationId: turn.id, payload: { toolCallId: event.toolCallId,
        title: event.toolName, status: event.isError ? "failed" : "completed", rawOutput: event.result } });
    } else if (event.type === "agent_settled") {
      if (turn.cancelled || event.aborted || turn.lastMessage?.stop === "aborted") turn.settled = { reason: "cancelled" };
      else if (turn.lastMessage?.stop === "stop" && turn.lastMessage.text.trim()) turn.settled = { reason: "end_turn" };
      else turn.settled = { reason: "error", error: turn.lastMessage?.error ?? `Pi settled without a complete answer (${turn.lastMessage?.stop ?? "no assistant message"})` };
    }
  }

  private publishBinding(session: Session): void {
    session.binding({ identity: { id: session.native.sessionId } });
  }

  private async finish(session: Session, reason: "end_turn" | "error" | "cancelled", error?: string): Promise<void> {
    const turn = session.active;
    if (!turn) return;
    if (turn.compactionFailure && !turn.cancelled) { reason = "error"; error = turn.compactionFailure; }
    // Native input hooks may still enqueue after prompt settlement. Fence them before releasing this binding.
    turn.closing = true;
    await Promise.allSettled([...turn.admissions]);
    session.native.clearQueue?.();
    for (const messageId of turn.steering.keys()) session.sink({ kind: "input_delivery_update", invocationId: turn.id,
      payload: { messageId, state: "failed", detail: "Invocation ended before queued steer was applied" } });
    turn.steering.clear();
    session.active = undefined;
    if (reason === "end_turn" && turn.lastMessage) session.sink({ kind: "agent_message", invocationId: turn.id,
      payload: { messageId: turn.lastMessage.id, phase: "final", content: [{ type: "text", text: turn.lastMessage.text }] } });
    if (reason === "error") session.sink({ kind: "_aide_error_update", invocationId: turn.id,
      payload: { code: "pi_execution_failed", message: error ?? "Pi execution failed", retryable: false, willRetry: false } });
    this.log("Pi turn settled", turn.id, reason);
    session.sink({ kind: "state_update", invocationId: turn.id, payload: { state: "idle", stopReason: reason } });
  }

  private log(message: string, turnId: string, reason?: string): void {
    this.options.log?.({ level: reason === "error" ? "error" : "info", source: "harness", component: "pi.adapter",
      harness: this.harness, message, invocationId: turnId, ...(reason ? { attributes: { reason } } : {}) });
  }
}
