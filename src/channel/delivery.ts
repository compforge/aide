import type { Logger } from "pino";
import type { OutputStore } from "../../plugins/personal/output/store.ts";
import { assertChannelDelivery, isChannelAddress } from "./address.ts";

/**
 * @spec A removed Channel cannot leave Output pending forever. Previous send attempts require inspection, never blind replay.
 * @why Admission and restart use the same ownership rule; the delivery layer owns recovery decisions and diagnostics.
 * @link docs/personal/output.md
 */
export function reconcileChannelOutputs(outputs: OutputStore, larkAppIds: readonly string[], log: Logger): void {
  for (const output of outputs.list()) {
    if (!isChannelAddress(output.spec.target) || !["pending", "sending"].includes(output.status.phase)) continue;
    try { assertChannelDelivery(output.spec.target, larkAppIds); }
    catch (error) {
      const phase = output.status.phase === "sending" || output.status.attempts > 0 ? "uncertain" : "failed";
      const reason = String(error).slice(0, 4000);
      log.error({ outputId: output.metadata.name, topicId: output.spec.topicId,
        target: output.spec.target, attempts: output.status.attempts, phase, retryable: false,
        error: reason }, "Output has no configured delivery Channel");
      outputs.update(output.metadata.name, status => ({ ...status, phase, nextAttemptAt: undefined, lastError: reason }));
    }
  }
}
