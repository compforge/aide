import { configPath, loadConfig } from "./config.ts";
import { resolveHarnessConfigs } from "./host/harness/config.ts";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { once } from "node:events";
import pino from "pino";
import { z } from "zod";
import { RequirementOutputDelivery } from "../plugins/personal/output/requirements.ts";
import { Connectors } from "../connectors/index.ts";
import { Aide } from "./app.ts";
import { createHarnessAdapter } from "./host/harness/registry.ts";
import { httpChannel } from "./api/index.ts";
import { larkProgress } from "./channel/lark/card.ts";
import { LarkChannel } from "./channel/lark/index.ts";
import { larkConfig, larkTransport } from "./channel/lark/client.ts";
import { withAsyncFileLock } from "./host/file-lock.ts";

const environment = Object.freeze({ ...process.env });
const log = pino({ level: environment.LOG_LEVEL ?? "info" });
const home = resolve(environment.AIDE_HOME ?? `${homedir()}/.aide`);
const path = resolve(home, "host");
const port = z.coerce.number().int().min(1).max(65535).parse(environment.AIDE_PORT ?? "7433");
const timezone = environment.AIDE_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
new Intl.DateTimeFormat("en", { timeZone: timezone });
const lark = larkConfig(environment);

await withAsyncFileLock(path, async () => {
  const file = configPath(home);
  const config = loadConfig();
  const cwd = resolve(environment.AIDE_CWD ?? process.cwd());
  const harnesses = await resolveHarnessConfigs(config, { home, cwd, file, environment, log });
  const connectors = Connectors.fromConfig(config.connectors, environment);
  const aide: Aide = new Aide(home, {
    config, connectors, larkAppId: lark?.appId,
    cwd, timezone, defaultHarnessConfig: harnesses.defaultHarnessConfig,
    createAdapter: (target, ports) => createHarnessAdapter(target, { ...ports, rootDir: home,
      targetConfig: target.harness === "weave" ? { harness: "weave" } : target.harness === "routine" ? { harness: "routine" } : target.harness === "task" ? { harness: "task" } : target.harness === "route" ? { harness: "route" } : target.harness === "chief" ? { harness: "chief" } : harnesses.defaultHarnessOptions,
      ...(target.harness === "weave" ? { weaveSession: aide.weaveSession(ports.scope, harnesses.weave) } : {}),
      ...(target.harness === "route" ? { routeSession: aide.routeSession(ports.scope, harnesses.route) } : {}),
      ...(target.harness === "pi" ? { piConfig: harnesses.pi } : {}),
      ...(target.harness === "routine" ? { routineSession: aide.routineSession(ports.scope, harnesses.routine) } : {}),
      ...(target.harness === "task" ? { taskSession: aide.taskSession(ports.scope, harnesses.task) } : {}),
      ...(target.harness === "chief" ? { chiefSession: aide.chiefSession(ports.scope, harnesses.chief) } : {}),
    }),
  }, log);
  const server = httpChannel(aide, log);
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  await aide.start();
  const requirementDelivery = new RequirementOutputDelivery(aide.outputStore, connectors, log);
  requirementDelivery.start();
  const bot = lark ? new LarkChannel(home, lark.appId, aide, larkTransport(lark, log), log, (id) => larkProgress(aide, id)) : undefined;
  if (bot) void bot.start().catch(() => log.error("Lark channel startup failed; check credentials and network"));
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
  await requirementDelivery.close();
  await aide.close();
  await closingBot;
  log.info("Aide stopped");
}, 0);
