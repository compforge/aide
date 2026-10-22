import { iconFor } from "@compforge/aide-plugin";
// canonical harness id 的叶子真相源：registry / config / adapters 都从这里取。
// 单列成无依赖文件的原因：config 校验只需要 id 集合，而 harness/registry.ts
// 携带 adapter 的完整依赖图（SDK、子进程封装）——"读配置"不应连带加载它，
// 反向 import（config → registry）还会成环。

export interface HarnessIdentity<Id extends string = string> {
  /** Canonical user-facing ID used by Target configuration. */
  readonly id: Id;
  /** Input aliases normalize to id; they never enter persisted events. */
  readonly aliases: readonly string[];
  readonly label: string;
  /** Frozen Ledger/native session key; bindings remain scoped by Target, not by this shared key. */
  readonly sessionKey: string;
  /** SVG path data in a 24 x 24 viewBox. */
  readonly icon: string;
}

/** 轻量 harness 身份目录；config / adapters 可以安全依赖，不会带入 adapter SDK。 */
export const HARNESS_IDENTITIES = {
  codex: { id: "codex", aliases: ["cx"], label: "Codex", sessionKey: "codex", icon: iconFor("harness:codex") },
  claude: { id: "claude", aliases: ["cc"], label: "Claude Code", sessionKey: "claude-code", icon: iconFor("harness:claude") },
  dsh: { id: "dsh", aliases: ["deepseek"], label: "DeepSeek Harness", sessionKey: "deepseek-harness", icon: iconFor("harness:dsh") },
  pi: { id: "pi", aliases: [], label: "Pi", sessionKey: "pi", icon: iconFor("harness:pi") },
  route: { id: "route", aliases: [], label: "Route", sessionKey: "route", icon: iconFor("harness:chief") },
  chief: { id: "chief", aliases: [], label: "Chief", sessionKey: "chief", icon: iconFor("harness:chief") },
} as const satisfies Record<string, HarnessIdentity>;

export type HarnessName = keyof typeof HARNESS_IDENTITIES;
export type HarnessAlias = (typeof HARNESS_IDENTITIES)[HarnessName]["aliases"][number];
export const HARNESSES = Object.keys(HARNESS_IDENTITIES) as HarnessName[];

/** 用户输入（Target 的 harness 字段）归一为 canonical id；未知返回 null */
export function parseHarness(value: string): HarnessName | null {
  const normalized = value.trim().toLowerCase();
  const identity = Object.values(HARNESS_IDENTITIES).find(
    (candidate) =>
      candidate.id === normalized || (candidate.aliases as readonly string[]).includes(normalized),
  );
  return identity?.id ?? null;
}

/** harness id + aliases 的前缀候选；按 harness 去重便于上层报歧义。 */
export function harnessPrefixMatches(value: string): HarnessName[] {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return [];
  const exact = parseHarness(normalized);
  if (exact) return [exact];
  return Object.values(HARNESS_IDENTITIES)
    .filter(
      (candidate) =>
        candidate.id.startsWith(normalized) ||
        (candidate.aliases as readonly string[]).some((alias) => alias.startsWith(normalized)),
    )
    .map((candidate) => candidate.id);
}

/** Resolve canonical IDs and persisted wire keys without loading adapter SDKs. */
export function harnessIdentityFor(value: string): HarnessIdentity | undefined {
  const id = parseHarness(value);
  return Object.values(HARNESS_IDENTITIES).find((item) => item.id === id || item.sessionKey === value);
}
