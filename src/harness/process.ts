import type { ChildProcess } from "node:child_process";

export function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have changed state between the check and group signal;
      // fall back to ChildProcess.kill for platforms without a live group.
    }
  }
  child.kill(signal);
}

