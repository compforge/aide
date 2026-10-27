import type { ConnectorKind } from "@compforge/aide-connector";
export interface TicketApi {
  read(key: string): Promise<{ key: string; connector: string; prefix: string }>;
  wait(ms: number): Promise<string>;
}
export const TicketKind: ConnectorKind<TicketApi> = { kind: "fixture.ticket", version: 1, methods: ["read", "wait"],
  validation: { read: {
    args: { parse(value: unknown): [string] {
      if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== "string") throw new Error("Ticket read requires one string key");
      return [value[0]];
    } },
    result: { parse(value: unknown) {
      const result = value as Awaited<ReturnType<TicketApi["read"]>>;
      if (!result || [result.key, result.connector, result.prefix].some(v => typeof v !== "string")) throw new Error("Invalid Ticket result");
      return result;
    } },
  } },
};
