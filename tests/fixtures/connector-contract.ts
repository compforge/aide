export interface TicketApi {
  read(key: string): Promise<{ key: string; connector: string; prefix: string }>;
  wait(ms: number): Promise<string>;
}
export const TicketKind = "fixture.ticket";
export const TicketVersion = "v1";
