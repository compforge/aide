import { homedir } from "node:os";
import { join, resolve } from "node:path";
import pino from "pino";
import { loadConfig } from "./config.ts";
import { syncChiefPackages } from "./harness-config.ts";
import { withAsyncFileLock } from "./host/file-lock.ts";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const home = resolve(process.env.AIDE_HOME ?? join(homedir(), ".aide"));
try {
  await withAsyncFileLock(join(home, "host"), () => syncChiefPackages(home, loadConfig(), log), 0);
} catch (error) {
  log.error({ err: error }, "Chief package sync failed; stop Aide before syncing and check package access");
  process.exitCode = 1;
}
