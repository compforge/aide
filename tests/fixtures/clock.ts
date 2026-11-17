import type { TestContext } from "node:test";

/** Advance deadline comparisons without modifying immutable business receipts. */
export function deadlineClock(t: Pick<TestContext, "after">) {
  const original = Date.now;
  let offset = 0;
  Date.now = () => original() + offset;
  t.after(() => { Date.now = original; });
  return (milliseconds: number) => { offset += milliseconds; };
}
