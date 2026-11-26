import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

export type ObservePiEntry = (scope: string, sessionId: string, entry: SessionEntry, origin?: string) => void;

/** Record after Pi assigns the durable entry ID, including usage appended outside the regular message loop. */
export function observeEntries(manager: SessionManager, scope: string, observe: ObservePiEntry): SessionManager {
  const appends = new Set(["appendMessage", "appendUsage", "appendCompaction", "branchWithSummary", "appendCustomEntry"]);
  let origin: string | undefined;
  return new Proxy(manager, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (typeof key !== "string" || !appends.has(key)) return value.bind(target);
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args);
        const entry = typeof result === "string" ? target.getEntry(result) : result as SessionEntry;
        if (!entry) return result;
        if (entry.type === "custom" && entry.customType === "aide.usage-origin") {
          origin = (entry.data as { origin: string }).origin;
        } else if (entry.type === "message" && entry.message.role === "user") {
          origin = undefined;
        } else if (entry.type !== "custom") {
          observe(scope, target.getSessionId(), entry, origin);
        }
        return result;
      };
    },
  });
}
