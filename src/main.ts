import { homedir } from "node:os";
import { resolve } from "node:path";
import { once } from "node:events";
import pino from "pino";
import { z } from "zod";
import { Aide } from "./core/aide.ts";
import { PersonalAgent } from "./core/agent.ts";
import { Store } from "./core/store.ts";
import { httpChannel } from "./channel/http.ts";
import { generateCodexStructured } from "./harness/codex.ts";
import { withAsyncFileLock } from "./runtime/file-lock.ts";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const path = resolve(process.env.AIDE_HOME ?? `${homedir()}/.aide`, "state.json");
const sandbox = z.enum(["read-only", "workspace-write", "danger-full-access"]).optional().parse(process.env.AIDE_SANDBOX);
const port = z.coerce.number().int().min(1).max(65535).parse(process.env.AIDE_PORT ?? "7433");
const timezone = process.env.AIDE_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
new Intl.DateTimeFormat("en", { timeZone: timezone });

await withAsyncFileLock(path, async () => {
  const shutdown = new AbortController();
  const agent = new PersonalAgent({ generate: (request) => generateCodexStructured({ ...request, signal: shutdown.signal }) }, {
    cwd: resolve(process.env.AIDE_CWD ?? process.cwd()), timezone, sandbox, model: process.env.AIDE_MODEL,
  });
  const aide = new Aide(new Store(path), agent, log);
  const server = httpChannel(aide, log);
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  aide.start();
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
  shutdown.abort();
  await aide.close();
  log.info("Aide stopped");
}, 0);
