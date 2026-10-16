import { homedir } from "node:os";
import { resolve } from "node:path";
import { once } from "node:events";
import pino from "pino";
import { z } from "zod";
import { Aide } from "./personal/aide.ts";
import { CodexAdapter } from "./runtime/harness/codex/adapter.ts";
import { FileHookTrustStore } from "./runtime/config/hook.ts";
import { httpChannel } from "./channel/http.ts";
import { withAsyncFileLock } from "./runtime/file-lock.ts";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const home = resolve(process.env.AIDE_HOME ?? `${homedir()}/.aide`);
const path = resolve(home, "host");
const sandbox = z.enum(["read-only", "workspace-write", "danger-full-access"]).optional().parse(process.env.AIDE_SANDBOX);
const port = z.coerce.number().int().min(1).max(65535).parse(process.env.AIDE_PORT ?? "7433");
const timezone = process.env.AIDE_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
new Intl.DateTimeFormat("en", { timeZone: timezone });

await withAsyncFileLock(path, async () => {
  const aide = new Aide(home, {
    cwd: resolve(process.env.AIDE_CWD ?? process.cwd()), timezone, model: process.env.AIDE_MODEL,
    createAdapter: (_target, ports) => new CodexAdapter({ ...ports,
      ...(sandbox ? { command: ["codex", "app-server", "-c", `sandbox_mode="${sandbox}"`] } : {}),
      hookTrustStore: new FileHookTrustStore(_target.id, home) }),
  }, log);
  const server = httpChannel(aide, log);
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  await aide.start();
  log.info({ port, path }, "Aide listening on localhost");
  await new Promise<void>((done) => {
    const stop = () => {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      done();
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  });
  server.close();
  await aide.close();
  log.info("Aide stopped");
}, 0);
