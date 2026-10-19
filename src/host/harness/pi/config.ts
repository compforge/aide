import { resolve, join } from "node:path";
import { z } from "zod";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

const text = z.string().trim().min(1);
export const PiModelConfigSchema = z.object({
  provider: text, id: text, name: text.optional(), api: text.optional(),
  baseUrl: z.url().optional(), apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  reasoning: z.boolean().optional(), input: z.array(z.enum(["text", "image"])).min(1).optional(),
  contextWindow: z.number().int().positive().optional(), maxTokens: z.number().int().positive().optional(),
}).strict();
export const PiConfigSchema = z.object({
  model: PiModelConfigSchema.optional(),
  packages: z.array(text).default([]),
}).strict();

export type PiModelConfigInput = z.infer<typeof PiModelConfigSchema>;
type Model = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
type Provider = NonNullable<ReturnType<ModelRuntime["getProvider"]>>;
type Settings = ReturnType<SettingsManager["getSettings"]>;

/**
 * @spec One startup configuration is reused by every native session in this process. Agents never reopen model/settings files.
 * @link docs/configuration.md
 * @case tests/harness-config.test.ts
 */
export interface PiConfig {
  readonly agentDir: string;
  readonly model: Model;
  readonly settings: Readonly<Settings>;
  readonly modelRuntime: ModelRuntime;
  readonly skillPaths?: readonly string[];
}

/** Credentials remain SDK-owned; definitions and request settings are captured at startup. */
function snapshotProvider(provider: Provider, source: ModelRuntime, selected: Model): Provider {
  const models = provider.getModels().filter((model) => model.id !== selected.id || model.provider !== selected.provider);
  if (provider.id === selected.provider) models.push(selected);
  const headers = new Map(models.map((model) => [model.id, source.getCompatibilityRequestConfig(model).headers]));
  const otherModels = (provider.getAllModels?.() ?? []).filter((model) => model.type && model.type !== "chat");
  return {
    ...provider, refreshModels: undefined,
    getModels: () => models,
    getAllModels: () => [...otherModels, ...models],
    stream: (model, context, options) => provider.stream(model, context, {
      ...options, headers: { ...headers.get(model.id), ...options?.headers },
    } as typeof options),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, {
      ...options, headers: { ...headers.get(model.id), ...options?.headers },
    } as typeof options),
  };
}

function resolveModel(input: PiModelConfigInput, source: ModelRuntime): Model {
  const inherited = source.getModel(input.provider, input.id);
  const provider = source.getProvider(input.provider);
  // A new deployment inherits provider transport, never another model's capabilities.
  const apis = new Set(provider?.getModels().map((model) => model.api));
  const api = input.api ?? inherited?.api ?? (apis.size === 1 ? [...apis][0] : undefined);
  const baseUrl = input.baseUrl ?? inherited?.baseUrl ?? provider?.baseUrl;
  if (!api) throw new Error("model.api is required for this model");
  if (!getApiProvider(api)) throw new Error("model.api has no registered SDK implementation");
  if (!baseUrl) throw new Error("model.baseUrl is required for this model");
  const { apiKeyEnv: _credential, ...overrides } = input;
  return {
    // Pi's documented custom-model defaults; a different model ID starts here.
    name: input.id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...inherited, ...overrides, api, baseUrl,
  };
}

/** Called only by startup composition; inputs are configuration sources, not live watchers. */
export async function resolvePiConfig(options: {
  cwd: string; agentDir?: string; model?: PiModelConfigInput; skillPaths?: readonly string[];
  environment?: Readonly<Record<string, string | undefined>>;
}): Promise<PiConfig> {
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const settingsManager = SettingsManager.create(resolve(options.cwd), agentDir);
  if (settingsManager.drainErrors().length) throw new Error(`Invalid Pi settings in ${agentDir} or ${options.cwd}/.pi`);
  const settings = settingsManager.getSettings();
  const source = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  // SDK parse errors can contain source text; report the path without echoing it.
  if (source.getError()) throw new Error(`Invalid Pi models configuration: ${join(agentDir, "models.json")}`);
  let selection = options.model;
  if (!selection && (settings.defaultProvider || settings.defaultModel)) {
    if (!settings.defaultProvider || !settings.defaultModel) throw new Error("Pi defaultProvider and defaultModel must be configured together");
    selection = { provider: settings.defaultProvider, id: settings.defaultModel };
    if (!source.getModel(selection.provider, selection.id)) throw new Error("Pi default model is not registered");
  }
  const model = selection ? resolveModel(selection, source) : source.getAvailableSnapshot()[0];
  if (!model) throw new Error("No configured Pi model; declare a model and authentication");
  // No modelsPath: even SDK refresh cannot reread the user's models.json.
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null });
  for (const provider of source.getProviders()) modelRuntime.registerNativeProvider(snapshotProvider(provider, source, model));
  if (!source.getProvider(model.provider)) {
    modelRuntime.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, models: [model] });
  }
  if (options.model?.apiKeyEnv !== undefined) {
    const key = (options.environment ?? process.env)[options.model.apiKeyEnv];
    if (!key?.trim()) throw new Error(`model.apiKeyEnv references missing environment variable ${options.model.apiKeyEnv}`);
    await modelRuntime.setRuntimeApiKey(model.provider, key);
  }
  await modelRuntime.refresh({ allowNetwork: false });
  if (!modelRuntime.hasConfiguredAuth(model.provider)) throw new Error(`No authentication configured for model provider ${model.provider}`);
  const isolatedSettings = { ...settings, retry: { enabled: false }, httpIdleTimeoutMs: 60_000,
    ...(options.skillPaths === undefined ? {} : { packages: [], extensions: [], skills: [], prompts: [], themes: [] }) };
  return Object.freeze({ agentDir, model: Object.freeze(model), modelRuntime,
    settings: Object.freeze(isolatedSettings),
    ...(options.skillPaths === undefined ? {} : { skillPaths: Object.freeze([...options.skillPaths]) }) });
}
