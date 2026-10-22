import type { OutputView } from "../output.ts";
import type { ConversationStore } from "../../plugins/personal/conversation/store.ts";
import type { ApplicationRuntime } from "../host/runtime/index.ts";
import type { HarnessInvocationSnapshot } from "../host/plugin/harness-invocation.ts";
import type { InputReceipt, InputSpec } from "../../plugins/personal/input/model.ts";
import type { Incoming } from "./message.ts";

/** Channel-facing business state and application execution projection. */
export interface ChannelService {
  readonly runtime: Pick<ApplicationRuntime, "projection" | "resolveApproval">;
  readonly conversations: ConversationStore;
  subscribe(listener: () => void): () => void;
  receive(input: Incoming): Promise<InputReceipt>;
  inputDefinition(origin: Pick<InputSpec, "origin" | "originId">): { id: string; label: string; icon: string };
  outputs(): OutputView[];
  outputDelivered?(outputId: string): Promise<void>;
  outputSending?(outputId: string): Promise<void>;
  outputRetry?(outputId: string, error: string, nextAttemptAt: string): Promise<void>;
  invocations(): readonly HarnessInvocationSnapshot[];
  conversationIds(): string[];
}
