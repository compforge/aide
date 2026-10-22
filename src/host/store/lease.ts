import { existsSync, openSync, closeSync, writeSync, readFileSync, rmSync } from "node:fs";
class WriterInUseError extends Error {
  override readonly name = "WriterInUseError";
}

export function acquireWriterLock(path: string): boolean {
  // Each attempt either atomically creates the lock or rules out one stale holder.
  // Avoid existsSync before open: the gap between those operations is a TOCTOU race.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let holder: number;
    try {
      holder = Number(readFileSync(path, "utf8").trim());
    } catch {
      continue; // The holder released between open and read; retry the atomic create.
    }
    if (holder === process.pid) return false;
    if (Number.isFinite(holder) && holder > 0 && pidAlive(holder)) {
      throw new WriterInUseError(
        `Storage ${path} is in use by another aide process (pid ${holder})`,
      );
    }
    rmSync(path, { force: true });
  }
  throw new Error(`failed to acquire writer lock for ${path} after retries`);
}

export function releaseWriterLock(path: string): void {
  try {
    if (existsSync(path) && readFileSync(path, "utf8").trim() === String(process.pid)) {
      rmSync(path);
    }
  } catch {
    // A stale lock is safer than throwing during shutdown; the next acquire detects it.
  }
}

/** kill(pid, 0) 探活：EPERM 表示进程存在但无权限发信号，同样算活。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
