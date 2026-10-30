import type { OutputView } from "../output.ts";
import type { TopicStore } from "../../plugins/personal/topic/store.ts";
import type { ApplicationRuntime } from "../host/runtime/index.ts";
import type { HarnessInvocationSnapshot } from "../host/harness/invocation.ts";
import type { InputReceipt, InputSpec } from "../../plugins/personal/input/model.ts";
import type { Incoming } from "./message.ts";

/** Channel-facing business state and application execution projection. */
export interface ChannelService {
  readonly runtime: Pick<ApplicationRuntime, "executions">;
  readonly topics: TopicStore;
  subscribe(listener: () => void): () => void;
  receive(input: Incoming): Promise<InputReceipt>;
  inputDefinition(origin: Pick<InputSpec, "origin" | "originId">): { id: string; label: string; icon: string };
  outputs(): OutputView[];
  outputDelivered?(outputId: string): Promise<void>;
  outputSending?(outputId: string, expected?: { target: import("@compforge/aide-plugin").Address; text: string }): Promise<boolean | void>;
  outputRetry?(outputId: string, error: string, nextAttemptAt: string): Promise<void>;
  invocations(): readonly (HarnessInvocationSnapshot & { topicId?: string; inputId?: string; inputIds?: readonly string[] })[];
  topicIds(): string[];
}
