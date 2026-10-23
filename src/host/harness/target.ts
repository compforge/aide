import type { AvailableCommand } from "../event/index.ts";
import type { EffortOption, ModelOption } from "./adapter.ts";

/**
 * Aide 配置与调度侧的 Harness 目标。`harness` 选择执行实现与能力集，`id` 标识一份具体配置；
 * 同一种 Harness 可以有多个 target，但它们不能共享原生 session。
 */
export interface HarnessTarget {
  readonly id: string;
  readonly harness: string;
}

/**
 * 对 HarnessTarget 的只读发现结果。它不创建 HarnessSession，也不进入 Adapter 生命周期；
 * model / command 等静态目录可在用户真正发 turn 前安全查询。
 */
export interface HarnessTargetProbeResult {
  modelCatalog?: readonly HarnessModel[];
  models?: ModelOption[];
  efforts?: EffortOption[];
  commands?: AvailableCommand[];
}

/**
 * 一次 Harness open 实际采用的不可变配置。它属于 Aide 控制面，不穿透 Adapter 实例；
 * Adapter 工厂只消费 HarnessTarget 来选择实现和 lowering 实例级依赖，controller 仍把
 * cwd / model / effort 映射成 Adapter 的 OpenOptions 与能力调用。
 */
export interface HarnessLaunchSnapshot {
  readonly harnessTargetId: string;
  /** 选择 Adapter 的 Harness id，例如 `claude`。 */
  readonly harness: string;
  /** Adapter 事件与原生 session 使用的稳定 key，例如 `claude-code`。 */
  readonly harnessSessionKey: string;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: string;
}

export function createHarnessLaunchSnapshot(opts: {
  target: HarnessTarget;
  harnessSessionKey: string;
  cwd: string;
  model?: string;
  effort?: string;
}): HarnessLaunchSnapshot {
  return Object.freeze({
    harnessTargetId: opts.target.id,
    harness: opts.target.harness,
    harnessSessionKey: opts.harnessSessionKey,
    cwd: opts.cwd,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
  });
}

export interface HarnessModel {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly efforts: readonly { readonly id: string; readonly label: string }[];
}

/** 一份 HarnessTarget 的用户配置；`harness` 选择解析它的 HarnessDefinition。 */
export interface HarnessTargetConfig {
  readonly harness: string;
  /** 该 Target 启动 Harness 时覆盖的环境变量；用于选择账号目录等进程级配置。 */
  readonly env?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}


const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Adapter/probe 创建边界的严格校验：账号选择不能因坏配置静默回落到 Aide 进程环境。 */
export function targetEnvironmentFor(
  config: HarnessTargetConfig,
  targetId: string,
): Readonly<Record<string, string>> | undefined {
  if (config.env === undefined) return undefined;
  const supplied = config.env !== null && typeof config.env === "object" && !Array.isArray(config.env) ? config.env : undefined;
  if (!supplied) throw new Error(`HarnessTarget ${targetId} env must be a string map`);

  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(supplied)) {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new Error(`HarnessTarget ${targetId} env has invalid variable name: ${name}`);
    }
    if (typeof value !== "string") {
      throw new Error(`HarnessTarget ${targetId} env ${name} must be a string`);
    }
    environment[name] = value;
  }
  return Object.keys(environment).length > 0 ? Object.freeze(environment) : undefined;
}
