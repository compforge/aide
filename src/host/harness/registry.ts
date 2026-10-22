// harness 运行时定义的唯一权威：轻量身份（id + aliases）来自 ids.ts，
// wire/持久化 key、展示名、认色和 adapter 工厂在这里组装成 HarnessDefinition。
// 任何按名字分发、贴标签、着色的代码都必须经本模块归一。

import type { PiConfig } from "./pi/config.ts";
import { createPiAgent } from "../../../agents/pi/agent.ts";
import type { HarnessAdapter, OpenApproval, NativeEventSink } from "./adapter.ts";
import { ClaudeAdapter, probeClaudeTarget } from "./claude/adapter.ts";
import { resolveClaudeTargetConfig } from "./claude/config.ts";
import { claudeSessionInspector } from "./claude/native-session.ts";
import { CodexAdapter } from "./codex/adapter.ts";
import { probeCodexTarget } from "./codex/catalog.ts";
import { resolveCodexTargetConfig } from "./codex/config.ts";
import { codexSessionInspector } from "./codex/native-session.ts";
import { DshAdapter } from "./dsh/adapter.ts";
import { PiAdapter, type PiSessionFactory } from "./pi/adapter.ts";
import { resolveDshTargetConfig } from "./dsh/config.ts";
import {
  targetEnvironmentFor,
  type AideConfig,
  type HarnessTargetConfig,
} from "../config/config.ts";
import { FileHookTrustStore } from "../config/hook.ts";
import type { LogSink } from "../logging.ts";
import { HARNESS_IDENTITIES, HARNESSES, parseHarness, type HarnessName, type HarnessIdentity } from "./ids.ts";
import type { HarnessSessionInspector } from "./native-session.ts";
import type { HarnessTarget, HarnessTargetProbeResult } from "./target.ts";

export { HARNESSES, parseHarness, type HarnessName };

export interface HarnessAdapterOptions {
  /** Optional generic Pi factory; by default uses Pi configuration and native tools. */
  piSession?: PiSessionFactory;
  piConfig?: PiConfig;
  /** Personal composition supplies the Chief agent and conversation-scoped capabilities. */
  chiefSession?: PiSessionFactory;
  /** Adapter 工厂的实例坐标；工厂负责把 Target 配置 lowering 成具体 Adapter 依赖。 */
  target: HarnessTarget;
  openApproval: OpenApproval;
  log?: LogSink;
  nativeEvent?: NativeEventSink;
  targetConfig: HarnessTargetConfig;
  /** 已校验的 Target 固定环境；覆盖每次 open 动态传入的同名变量。 */
  env?: Readonly<Record<string, string>>;
  rootDir?: string;
}

export interface HarnessDefinition<Id extends string = string> extends HarnessIdentity<Id> {
  /** 时间线 author 短名，同时是着色 key（agentColorFor 的输入） */
  shortName: string;
  /** 固定认色：用户会形成"橙=claude"的肌肉记忆，颜色不随池子调整漂移 */
  color: string;
  create(options: HarnessAdapterOptions): HarnessAdapter;
  probe?: (options: HarnessProbeOptions) => Promise<HarnessTargetProbeResult>;
  /** Aide 外部 HarnessSession 的只读历史观察；不得启动或修改会话。 */
  sessionInspector?: HarnessSessionInspector;
}

export interface HarnessProbeOptions {
  target: HarnessTarget;
  cwd: string;
  env?: Record<string, string>;
  log?: LogSink;
  targetConfig: HarnessTargetConfig;
}

/**
 * @spec Pi and Chief have distinct Harness identities but share the Pi adapter; only composition binds Personal tools.
 * @link docs/harness/README.md
 */
export const HARNESS_REGISTRY = [
  {
    ...HARNESS_IDENTITIES.pi,
    shortName: "pi", color: "#a6da95",
    create: ({ piSession, piConfig, target, log, nativeEvent, env }) => {
      if (env && Object.keys(env).length) throw new Error("Embedded Pi targets do not support environment overrides; configure Pi's agentDir instead");
      if (!piSession && !piConfig) throw new Error("Pi target requires startup-resolved configuration");
      return new PiAdapter({ createSession: piSession ?? ((options) => createPiAgent({ ...options, config: piConfig!,
        scope: `pi:${target.id}` })), log, nativeEvent });
    },
  },
  {
    ...HARNESS_IDENTITIES.chief,
    shortName: "chief", color: "#a6da95",
    create: ({ chiefSession, log, nativeEvent, env }) => {
      if (!chiefSession) throw new Error("Chief target requires a host-bound Chief agent factory");
      if (env && Object.keys(env).length) throw new Error("Embedded Chief targets do not support environment overrides; configure Pi's agentDir instead");
      return new PiAdapter({ harness: "chief", createSession: chiefSession, log, nativeEvent });
    },
  },
  {
    ...HARNESS_IDENTITIES.codex,
    shortName: "codex",
    color: "#73daca", // 青
    sessionInspector: codexSessionInspector,
    probe: ({ cwd, env, targetConfig }) => probeCodexTarget({
      cwd, env, command: resolveCodexTargetConfig(targetConfig).command,
    }),
    create: ({ target, openApproval, log, nativeEvent, targetConfig, env, rootDir }) => {
      const config = resolveCodexTargetConfig(targetConfig);
      return new CodexAdapter({
        openApproval,
        log,
        nativeEvent,
        env,
        command: config.command,
        approvalReviewer: config.approvalReviewer,
        hookTrustStore: new FileHookTrustStore(target.id, rootDir),
      });
    },
  },
  {
    ...HARNESS_IDENTITIES.claude,
    shortName: "claude",
    color: "#ff9e64", // 橙
    sessionInspector: claudeSessionInspector,
    create: ({ openApproval, log, nativeEvent, targetConfig, env }) => {
      const config = resolveClaudeTargetConfig(targetConfig);
      return new ClaudeAdapter({
        openApproval,
        log,
        nativeEvent,
        env,
        executablePath: config.executable,
      });
    },
    probe: ({ cwd, env, log, targetConfig }) => {
      const config = resolveClaudeTargetConfig(targetConfig);
      return probeClaudeTarget({
        cwd,
        env,
        log,
        executablePath: config.executable,
      });
    },
  },
  {
    ...HARNESS_IDENTITIES.dsh,
    shortName: "dsh",
    color: "#4d6bfe", // DeepSeek 蓝
    create: ({ log, nativeEvent, targetConfig, env }) => {
      const config = resolveDshTargetConfig(targetConfig);
      return new DshAdapter({
        log,
        nativeEvent,
        env,
        ...config,
      });
    },
  },
] as const satisfies readonly HarnessDefinition<HarnessName>[];

/**
 * 按 canonical id、alias **或** wire key 归一到 definition。
 * 未知输入返回 undefined（harness 是开放扩展点）。
 */
export function harnessDefinitionFor(idOrSessionKey: string): HarnessDefinition | undefined {
  const canonicalId = parseHarness(idOrSessionKey);
  return HARNESS_REGISTRY.find(
    (candidate) => candidate.id === canonicalId || candidate.sessionKey === idOrSessionKey,
  );
}

/** 配置中的 Target id 是唯一查找键；Harness 名只选择 Definition，不充当 Target identity。 */
export function resolveHarnessTarget(
  config: AideConfig,
  harnessTargetId: string,
): HarnessTarget | undefined {
  const targetConfig = config.targets[harnessTargetId];
  if (!targetConfig) return undefined;
  const definition = harnessDefinitionFor(targetConfig.harness);
  return definition
    ? Object.freeze({ id: harnessTargetId, harness: definition.id })
    : undefined;
}

export function configuredHarnessTargets(config: AideConfig): HarnessTarget[] {
  return Object.keys(config.targets).flatMap((targetId) => {
    const target = resolveHarnessTarget(config, targetId);
    return target ? [target] : [];
  });
}

/** CLI/TUI 选择：Target id 精确匹配优先，Harness id/alias 只选择该家的默认 Target。 */
export function resolveHarnessTargetSelection(
  config: AideConfig,
  value: string,
): HarnessTarget | undefined {
  const exact = resolveHarnessTarget(config, value);
  if (exact) return exact;
  const harness = parseHarness(value);
  if (!harness) return undefined;
  const candidates = configuredHarnessTargets(config).filter((target) => target.harness === harness);
  return candidates.find((target) => target.id === harness) ?? (
    candidates.length === 1 ? candidates[0] : undefined
  );
}

/** 时间线 author / 着色 key；未知 harness 原样返回（开放扩展点的兜底展示） */
export function harnessShortName(idOrSessionKey: string): string {
  return harnessDefinitionFor(idOrSessionKey)?.shortName ?? idOrSessionKey;
}

export function createHarnessAdapter(
  target: HarnessTarget,
  options: Omit<HarnessAdapterOptions, "target">,
): HarnessAdapter {
  const definition = HARNESS_REGISTRY.find((candidate) => candidate.id === target.harness);
  if (!definition) {
    throw new Error(`HarnessTarget ${target.id} references an unregistered Harness: ${target.harness}`);
  }
  if (harnessDefinitionFor(options.targetConfig.harness)?.id !== target.harness) {
    throw new Error(
      `HarnessTarget config mismatch for ${target.id}: target=${target.harness}, config=${options.targetConfig.harness}`,
    );
  }
  const env = targetEnvironmentFor(options.targetConfig, target.id);
  return definition.create({
    ...options,
    target,
    ...(env ? { env } : {}),
  });
}

/** Target 级发现的唯一入口；没有 probe 的 Harness 返回空快照，不为发现而创建 Adapter。 */
export async function probeHarnessTarget(
  target: HarnessTarget,
  options: Omit<HarnessProbeOptions, "target">,
): Promise<HarnessTargetProbeResult> {
  const definition = HARNESS_REGISTRY.find((candidate) => candidate.id === target.harness);
  if (!definition) {
    throw new Error(`HarnessTarget ${target.id} references an unregistered Harness: ${target.harness}`);
  }
  if (harnessDefinitionFor(options.targetConfig.harness)?.id !== target.harness) {
    throw new Error(
      `HarnessTarget config mismatch for ${target.id}: target=${target.harness}, config=${options.targetConfig.harness}`,
    );
  }
  const targetEnv = targetEnvironmentFor(options.targetConfig, target.id);
  const env = options.env || targetEnv
    ? { ...options.env, ...targetEnv }
    : undefined;
  return "probe" in definition && definition.probe
    ? definition.probe({ ...options, target, ...(env ? { env } : {}) })
    : {};
}

export function harnessSessionKey(harness: HarnessName): string {
  const definition = HARNESS_REGISTRY.find((candidate) => candidate.id === harness);
  if (!definition) throw new Error(`Harness not registered: ${harness}`);
  return definition.sessionKey;
}
