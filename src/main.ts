import { homedir } from "node:os";
import { resolve } from "node:path";
import { once } from "node:events";
import pino from "pino";
import { z } from "zod";
import { Aide } from "../plugins/personal/aide.ts";
import { createHarnessAdapter } from "./host/harness/registry.ts";
import { httpChannel } from "./channel/http.ts";
import { feishuProgress } from "./channel/feishu-card.ts";
import { FeishuChannel } from "./channel/feishu.ts";
import { feishuConfig, feishuTransport } from "./channel/feishu-client.ts";
import { withAsyncFileLock } from "./host/file-lock.ts";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const home = resolve(process.env.AIDE_HOME ?? `${homedir()}/.aide`);
const path = resolve(home, "host");
const sandbox = z.enum(["read-only", "workspace-write", "danger-full-access"]).optional().parse(process.env.AIDE_SANDBOX);
const port = z.coerce.number().int().min(1).max(65535).parse(process.env.AIDE_PORT ?? "7433");
const timezone = process.env.AIDE_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
new Intl.DateTimeFormat("en", { timeZone: timezone });
const feishu = feishuConfig(process.env);

await withAsyncFileLock(path, async () => {
  const aide: Aide = new Aide(home, {
    cwd: resolve(process.env.AIDE_CWD ?? process.cwd()), timezone, model: process.env.AIDE_MODEL,
    createAdapter: (target, ports) => createHarnessAdapter(target, { ...ports, rootDir: home,
      targetConfig: { harness: target.harness,
        ...(target.harness === "codex" && sandbox ? { command: ["codex", "app-server", "-c", `sandbox_mode="${sandbox}"`] } : {}) },
      ...(target.harness === "chief" ? { chiefSession: aide.chiefSession(target.id) } : {}),
    }),
  }, log);
  const server = httpChannel(aide, log);
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  await aide.start();
  const bot = feishu ? new FeishuChannel(home, feishu.appId, aide, feishuTransport(feishu, log), log, (id) => feishuProgress(aide, id)) : undefined;
  if (bot) void bot.start().catch(() => log.error("Feishu channel startup failed; check credentials and network"));
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
  server.closeAllConnections(); // Close long-lived web streams and release their subscriptions on shutdown.
  const closingBot = bot?.close();
  await aide.close();
  await closingBot;
  log.info("Aide stopped");
}, 0);
