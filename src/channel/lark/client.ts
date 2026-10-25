import * as Lark from "@larksuiteoapi/node-sdk";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Logger } from "pino";
import { z } from "zod";
import type { LarkChannelConfig } from "../config.ts";

export type LarkConfig = Pick<LarkChannelConfig, "appId" | "appSecret">;

export interface LarkCardTransport {
  create(card: unknown): Promise<string>;
  send(chatId: string, cardId: string, id: string): Promise<void>;
  content(cardId: string, elementId: string, content: string, sequence: number, id: string): Promise<void>;
  patch(cardId: string, elements: Record<string, unknown>, sequence: number, id: string): Promise<void>;
  settings(cardId: string, streaming: boolean, sequence: number, id: string): Promise<void>;
  update(cardId: string, card: unknown, sequence: number, id: string): Promise<void>;
}

export interface LarkTransport {
  readonly botIdentity?: Lark.BotIdentity;
  cards?: LarkCardTransport;
  start(receive: (event: unknown) => void | Promise<void>): Promise<void>;
  send(receiveId: string, text: string, id: string, receiveIdType?: "chat_id" | "open_id", replyToMessageId?: string): Promise<void>;
  close(): void;
}

class LarkSendError extends Error {
  constructor(readonly code: number | undefined) { super(`Lark message.create failed (code ${code ?? "missing"})`); }
}
const SendFailureSchema = z.object({
  code: z.unknown().optional(),
  response: z.object({ status: z.number().int().min(100).max(599).optional(),
    data: z.object({ code: z.number().int().optional() }).optional() }).optional(),
});
const networkCodes = new Set(["ETIMEDOUT", "ECONNABORTED", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ERR_CANCELED"]);
/** @spec Only diagnostic codes cross the SDK error boundary; request config, headers, body and free-form messages never enter logs or Output status. */
export function larkSendFailure(error: unknown) {
  const parsed = SendFailureSchema.safeParse(error);
  const value = parsed.success ? parsed.data : undefined;
  const code = value?.response?.data?.code ?? (typeof value?.code === "number" && Number.isSafeInteger(value.code) ? value.code : undefined);
  const transportCode = typeof value?.code === "string" && networkCodes.has(value.code) ? value.code : undefined;
  const httpStatus = value?.response?.status;
  const detail = { ...(code !== undefined ? { apiCode: code } : {}), ...(httpStatus ? { httpStatus } : {}), ...(transportCode ? { transportCode } : {}) };
  return { ...detail, error: `Lark message.create failed${Object.keys(detail).length ? ` (${JSON.stringify(detail)})` : "; no diagnostic code available"}` };
}

/** @why SDK errors may contain credentials in HTTP config; only log known lifecycle signals. */
export function larkTransport(config: LarkConfig, log: Logger): LarkTransport {
  const logger = {
    error: () => { log.error("Lark SDK request or connection failed; check credentials, scopes and network"); },
    warn: () => { log.warn("Lark SDK warning"); },
    info: () => {},
    debug: () => {},
    trace: () => {},
  };
  // The SDK interceptor unwraps response.data; Axios's generic return type does not describe that.
  const base = Lark.defaultHttpInstance as Lark.HttpInstance;
  const httpInstance: Lark.HttpInstance = {
    request: (opts) => base.request({ ...opts, timeout: 15_000 }),
    get: (url, opts) => base.get(url, { ...opts, timeout: 15_000 }),
    post: (url, data, opts) => base.post(url, data, { ...opts, timeout: 15_000 }),
    put: (url, data, opts) => base.put(url, data, { ...opts, timeout: 15_000 }),
    patch: (url, data, opts) => base.patch(url, data, { ...opts, timeout: 15_000 }),
    delete: (url, opts) => base.delete(url, { ...opts, timeout: 15_000 }),
    head: (url, opts) => base.head(url, { ...opts, timeout: 15_000 }),
    options: (url, opts) => base.options(url, { ...opts, timeout: 15_000 }),
  };
  const options = { ...config, domain: Lark.Domain.Feishu, logger, loggerLevel: Lark.LoggerLevel.warn, httpInstance };
  const client = new Lark.Client({ ...options, appType: Lark.AppType.SelfBuild });
  let botIdentity: Lark.BotIdentity | undefined;
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
  const ws = new Lark.WSClient({ ...options, ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {}),
    handshakeTimeoutMs: 15_000,
    onReady: () => log.info("Lark WebSocket connected"),
    onReconnected: () => log.info("Lark WebSocket connected"),
    onReconnecting: () => log.warn("Lark WebSocket disconnected; SDK will reconnect"),
    onError: () => log.error("Lark WebSocket failed; check app configuration and restart Aide"),
  });
  return {
    get botIdentity() { return botIdentity; },
    async start(receive) {
      try {
        const response = await client.request<{ code?: number; bot?: { open_id?: string; app_name?: string } }>({
          url: "/open-apis/bot/v3/info", method: "GET",
        });
        if (response.code !== 0 || !response.bot?.open_id) throw new Error("Bot identity unavailable");
        botIdentity = { openId: response.bot.open_id, name: response.bot.app_name ?? "Aide" };
        log.info({ botOpenId: botIdentity.openId }, "Lark bot identity resolved");
      } catch {
        log.warn("Lark bot identity unavailable; group mentions disabled, direct messages remain available");
      }
      const eventDispatcher = new Lark.EventDispatcher({ logger }).register({ "im.message.receive_v1": async (event) => receive(event) });
      await ws.start({ eventDispatcher });
    },
    async send(receiveId, text, id, receiveIdType = "chat_id", replyToMessageId) {
      const response = replyToMessageId ? await client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { msg_type: "text", content: JSON.stringify({ text }), uuid: id, reply_in_thread: true },
      }) : await client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: receiveId, msg_type: "text", content: JSON.stringify({ text }), uuid: id },
      });
      if (response.code !== 0 || !response.data?.message_id) {
        throw new LarkSendError(response.code);
      }
    },
    cards: {
      async create(card) {
        const response = await client.cardkit.v1.card.create({ data: { type: "card_json", data: JSON.stringify(card) } });
        if (response.code !== 0 || !response.data?.card_id) throw new Error(`Lark card.create failed (code ${response.code ?? "missing"})`);
        return response.data.card_id;
      },
      async send(chatId, cardId, id) {
        const response = await client.im.message.create({ params: { receive_id_type: "chat_id" },
          data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify({ type: "card", data: { card_id: cardId } }), uuid: id } });
        if (response.code !== 0 || !response.data?.message_id) throw new Error(`Lark card.send failed (code ${response.code ?? "missing"})`);
      },
      async content(cardId, elementId, content, sequence, id) {
        checkCard(await client.cardkit.v1.cardElement.content({ path: { card_id: cardId, element_id: elementId }, data: { content, sequence, uuid: id } }), "content");
      },
      async patch(cardId, elements, sequence, id) {
        const actions = Object.entries(elements).map(([element_id, partial_element]) => ({
          action: "partial_update_element", params: { element_id, partial_element },
        }));
        checkCard(await client.cardkit.v1.card.batchUpdate({ path: { card_id: cardId },
          data: { actions: JSON.stringify(actions), sequence, uuid: id } }), "batchUpdate");
      },
      async settings(cardId, streaming, sequence, id) {
        checkCard(await client.cardkit.v1.card.settings({ path: { card_id: cardId },
          data: { settings: JSON.stringify({ config: { streaming_mode: streaming } }), sequence, uuid: id } }), "settings");
      },
      async update(cardId, card, sequence, id) {
        checkCard(await client.cardkit.v1.card.update({ path: { card_id: cardId },
          data: { card: { type: "card_json", data: JSON.stringify(card) }, sequence, uuid: id } }), "update");
      },
    },
    close() { ws.close({ force: true }); },
  };
}

function checkCard(response: { code?: number }, operation: string): void {
  if (response.code !== 0) throw new Error(`Lark card.${operation} failed (code ${response.code ?? "missing"})`);
}
