import * as Lark from "@larksuiteoapi/node-sdk";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Logger } from "pino";
import { z } from "zod";

const ConfigSchema = z.object({ appId: z.string().min(1), appSecret: z.string().min(1) });
export type FeishuConfig = z.infer<typeof ConfigSchema>;

export function feishuConfig(env: NodeJS.ProcessEnv): FeishuConfig | undefined {
  if (!env.AIDE_FEISHU_APP_ID && !env.AIDE_FEISHU_APP_SECRET) return undefined;
  const parsed = ConfigSchema.safeParse({ appId: env.AIDE_FEISHU_APP_ID, appSecret: env.AIDE_FEISHU_APP_SECRET });
  if (!parsed.success) throw new Error("Set both AIDE_FEISHU_APP_ID and AIDE_FEISHU_APP_SECRET");
  return parsed.data;
}

export interface FeishuTransport {
  start(receive: (event: unknown) => void): Promise<void>;
  send(chatId: string, text: string, id: string): Promise<void>;
  close(): void;
}

/** @why SDK errors may contain credentials in HTTP config; only log known lifecycle signals. */
export function feishuTransport(config: FeishuConfig, log: Logger): FeishuTransport {
  const logger = {
    error: () => { log.error("Feishu SDK request or connection failed; check credentials, scopes and network"); },
    warn: () => { log.warn("Feishu SDK warning"); },
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
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
  const ws = new Lark.WSClient({ ...options, ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {}),
    handshakeTimeoutMs: 15_000,
    onReady: () => log.info("Feishu WebSocket connected"),
    onReconnected: () => log.info("Feishu WebSocket connected"),
    onReconnecting: () => log.warn("Feishu WebSocket disconnected; SDK will reconnect"),
    onError: () => log.error("Feishu WebSocket failed; check app configuration and restart Aide"),
  });
  return {
    async start(receive) {
      const eventDispatcher = new Lark.EventDispatcher({ logger }).register({ "im.message.receive_v1": async (event) => receive(event) });
      await ws.start({ eventDispatcher });
    },
    async send(chatId, text, id) {
      const response = await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }), uuid: id },
      });
      if (response.code !== 0 || !response.data?.message_id) {
        throw new Error(`Feishu message.create failed (code ${response.code ?? "missing"})`);
      }
    },
    close() { ws.close({ force: true }); },
  };
}
