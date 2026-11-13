import type { PluginContext } from "@compforge/aide-plugin";
import { retryOnConflict } from "@compforge/aide-plugin";
import { inputPolicy } from "./config.ts";
import type { Attempt, InputStatus } from "./model.ts";
import { resourceRef, type Input } from "./state.ts";
import { patchStatus } from "../status.ts";

/** @spec Completion-based retention waits for all obligations; creation-based expiry is an independent hard upper bound.
 * @link docs/personal/input.md#保留与回收
 */
export function terminalAttempts(status: InputStatus): Attempt[] | undefined {
  const attempts = [status.route, ...(status.assess ? [status.assess] : []), ...Object.values(status.handle ?? {})];
  if (status.route?.nextAttemptAt && !status.route.completedAt) return;
  if (attempts.some(a => !a?.completedAt && !(a?.lastError && a.errorAt && !a.retryable))) return;
  return attempts as Attempt[];
}
const defaults = inputPolicy().retention;
/** @spec Every Input expires no later than creationTimestamp + errorSeconds, including pending and retrying inputs. */
export function inputHardExpiry(input: Pick<Input, "metadata" | "status">): string {
  return new Date(Date.parse(input.metadata.creationTimestamp) + (input.status.retention ?? defaults).errorSeconds * 1000).toISOString();
}
export function inputExpired(input: Pick<Input, "metadata" | "status">, now = Date.now()): boolean {
  return Date.parse(inputHardExpiry(input)) <= now;
}
export function inputPressure(input: Input): { tier: "low" | "high" | "full"; at: string } {
  const finished = terminalAttempts(input.status);
  if (finished?.every(a => !!a.completedAt)) return { tier: "low", at: finished.map(a => a.completedAt!).sort().at(-1)! };
  const errors = [input.status.route, input.status.assess, ...Object.values(input.status.handle ?? {})]
    .flatMap(a => a?.errorAt ? [a.errorAt] : []).sort();
  return errors.length ? { tier: "high", at: errors[0]! } : { tier: "full", at: input.metadata.creationTimestamp };
}
export function inputExpiry(status: InputStatus, retention: ReturnType<typeof inputPolicy>["retention"]): string | undefined {
  const attempts = terminalAttempts(status);
  if (!attempts) return;
  return new Date(Math.max(...attempts.map(a => Date.parse(a.completedAt ?? a.errorAt!)
    + (a.completedAt ? retention.successSeconds : retention.errorSeconds) * 1000))).toISOString();
}

export async function reconcileInputRetention(context: PluginContext, input: Input) {
  const policy = inputPolicy(context.instance.config.input);
  await retryOnConflict(async () => {
    const current = await context.resources.get<Input["spec"], Input["status"]>(resourceRef(input));
    if (!current || current.metadata.deletionTimestamp) return;
    if (current.status.retention?.successSeconds === policy.retention.successSeconds
      && current.status.retention?.errorSeconds === policy.retention.errorSeconds) return;
    await patchStatus(context.resources, current, { retention: policy.retention });
    context.logger.debug("Input retention policy resolved", { attributes: { inputId: current.metadata.name, ...policy.retention } });
  });
}
