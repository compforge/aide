import type { ConnectorDefinition, ConnectorPackage } from "@compforge/aide-connector";
import { TicketKind, TicketVersion, type TicketApi } from "./connector-contract.ts";
interface Config { prefix: string; tokenEnv: string }
const definition = (type: string): ConnectorDefinition<Config, TicketApi> => ({ type, kind: TicketKind, version: TicketVersion,
  config: { parse(value: unknown) {
    const config = value as Config;
    if (!config || typeof config.prefix !== "string" || typeof config.tokenEnv !== "string") throw new Error("Invalid Ticket config");
    return config;
  } },
  create(context, config) {
    const token = context.env(config.tokenEnv);
    if (!token) throw new Error("Ticket credential is absent");
    return { metadata: { prefix: config.prefix, authenticated: true }, handlers: {
      async read(_call, key) { return { key, connector: context.name, prefix: config.prefix }; },
      async wait(call, ms) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { call.signal.removeEventListener("abort", onAbort); resolve(); }, ms);
          const onAbort = () => { clearTimeout(timer); reject(new Error("Ticket cancelled")); };
          call.signal.addEventListener("abort", onAbort, { once: true });
          if (call.signal.aborted) onAbort();
        });
        return context.name;
      },
    }, close() {
      const root = globalThis as typeof globalThis & { ticketConnectorsClosed?: string[] };
      (root.ticketConnectorsClosed ??= []).push(context.name);
    } };
  },
});
export default { id: "fixture-connectors", version: "1.0.0", connectors: [definition("fixture-one"), definition("fixture-two")] } satisfies ConnectorPackage;
