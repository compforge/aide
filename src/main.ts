import { disclosureCheck } from "../agents/disclosure/check.ts";
import { larkEndpoint } from "./channel/address.ts";
import { PiObservations, ObservationConfigSchema } from "../agents/pi/observation.ts";
import type { PiConfig } from "./host/harness/pi/config.ts";
import { ChannelSettings } from "./channel/settings.ts";
import { configPath, loadConfig } from "./config.ts";
import { resolveHarnessConfigs } from "./host/harness/config.ts";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
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
import { larkTransport } from "./channel/lark/client.ts";
import { withAsyncFileLock } from "./host/file-lock.ts";

export async function startAide(options: { connectorRegistration?: import("@compforge/aide-connector").ConnectorPackage } = {}): Promise<void> {
const environment = Object.freeze({ ...process.env });
const log = pino({ level: environment.LOG_LEVEL ?? "info" });
const home = resolve(environment.AIDE_HOME ?? `${homedir()}/.aide`);
const path = resolve(home, "host");
const host = environment.AIDE_HOST ?? "0.0.0.0";
const port = z.coerce.number().int().min(1).max(65535).parse(environment.AIDE_PORT ?? "7433");
const timezone = environment.AIDE_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
new Intl.DateTimeFormat("en", { timeZone: timezone });

await withAsyncFileLock(path, async () => {
  const file = configPath(home);
  const config = loadConfig();
  const cwd = resolve(environment.AIDE_CWD ?? process.cwd());
  const resolved = await resolveHarnessConfigs(config, { home, cwd, file, environment, log });
  const observation = new PiObservations(resolve(home, "observations/pi"), ObservationConfigSchema.parse(config.observation ?? {}), log);
  log.info({ observation: ObservationConfigSchema.parse(config.observation ?? {}) }, "Resolved Pi observation policy");
  const observed = (config: PiConfig) => ({ ...config, observation });
  const harnesses = { ...resolved, chief: observed(resolved.chief), route: observed(resolved.route), weave: observed(resolved.weave),
    task: observed(resolved.task), routine: observed(resolved.routine), pi: resolved.pi && observed(resolved.pi) };
  const sessionConfigs: Record<string, PiConfig | undefined> = { chief: harnesses.chief, route: harnesses.route, weave: harnesses.weave,
    task: harnesses.task, routine: harnesses.routine, pi: harnesses.pi };
  const connectors = await Connectors.load(config.connectors, { environment, registration: environment.AIDE_CONNECTOR_REGISTRATION ?? options.connectorRegistration, baseDir: dirname(file), log: (message, attributes) => log.info(attributes, message) });
  try {
    const transports = new Map(Object.values(config.channels).filter(c => c.enabled).map(c => [c.appId, larkTransport(c, log.child({ appId: c.appId }))]));
    const aide: Aide = new Aide(home, {
      checkDisclosure: disclosureCheck(cwd, harnesses.chief),
      destinationAudience: async target => {
        const endpoint = larkEndpoint(target);
        const transport = endpoint && transports.get(endpoint.appId);
        if (!endpoint || !transport?.audience) return { identities: [], complete: false, private: false };
        const audience = await transport.audience(endpoint.receiveId);
        return { ...audience, identities: audience.openIds.map(id => ({ provider: "lark", scope: endpoint.appId, id })) };
      },
      config, connectors, connectorCatalog: await connectors.list(),
      readSession: agent => {
        const selected = sessionConfigs[agent.harness];
        if (!selected) throw new Error("Session observation is not supported for this Harness");
        return observation.read(cwd, selected, agent.sessionId);
      },
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
    const server = httpChannel(aide, log, new ChannelSettings(file, config, log));
    server.listen(port, host);
    await once(server, "listening");
    await aide.start();
    const requirementDelivery = new RequirementOutputDelivery(aide.outputStore, connectors, log);
    requirementDelivery.start();
    const bots = Object.entries(config.channels).filter(([, channel]) => channel.enabled).map(([id, channel]) => {
      const channelLog = log.child({ channelId: id, appId: channel.appId });
      const bot = new LarkChannel(home, channel.appId, aide, transports.get(channel.appId)!, channelLog, topicId => larkProgress(aide, topicId));
      void bot.start().catch(() => channelLog.error("Lark channel startup failed; check credentials and network"));
      return bot;
    });
    log.info({ host, port, path }, "Aide listening");
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
    const closingBots = Promise.all(bots.map(bot => bot.close()));
    await requirementDelivery.close();
    await aide.close();
    await closingBots;
    log.info("Aide stopped");
  } finally { await connectors.close(); }
}, 0);

}

if (import.meta.main) await startAide();
