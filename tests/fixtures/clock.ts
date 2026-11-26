import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";

/** Advance deadline comparisons without modifying immutable business receipts. */
export function deadlineClock(t: Pick<TestContext, "after">) {
  const original = Date.now;
  let offset = 0;
  Date.now = () => original() + offset;
  t.after(() => { Date.now = original; });
  return (milliseconds: number) => { offset += milliseconds; };
}

/** Yield to the real controllers and SDK while advancing only replay's polling clock. */
export function replayClock(canFastForward = () => true) {
  let elapsed = 0;
  return {
    now: () => elapsed,
    async wait(milliseconds: number) {
      await delay(canFastForward() ? Math.min(10, milliseconds) : milliseconds);
      elapsed += milliseconds;
    },
  };
}
