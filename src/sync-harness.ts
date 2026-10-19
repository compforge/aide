import { homedir } from "node:os";
import { join, resolve } from "node:path";
import pino from "pino";
import { loadConfig } from "./config.ts";
import { syncChiefPackages } from "./host/harness/chief/packages.ts";
import { withAsyncFileLock } from "./host/file-lock.ts";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const home = resolve(process.env.AIDE_HOME ?? join(homedir(), ".aide"));
try {
  // Stale-lock cleanup needs a retry; a live service should still fail quickly.
  await withAsyncFileLock(join(home, "host"), () => syncChiefPackages(home, loadConfig(), log), 50);
} catch (error) {
  log.error({ err: error }, "Chief package sync failed; stop Aide before syncing and check package access");
  process.exitCode = 1;
}
