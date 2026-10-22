/** Native Harness permissions and Hook trust; business communication uses Output. */
export interface PermissionOption {
  optionId: string;
  /** Harness 原话标签；它是当前候选语义的权威来源。 */
  name: string;
  polarity: "allow" | "reject";
  /** 只表达持续时间，不表达授权覆盖的资源。 */
  lifetime: "once" | "session" | "persistent";
}

export interface PermissionApproval {
  kind: "permission";
  title: string;
  description?: string;
  toolCallId?: string;
  options: PermissionOption[];
}

export interface HookTrustCandidate {
  key: string;
  source: string;
  sourcePath: string;
  trustStatus: "untrusted" | "modified";
  command: string;
  matcher?: string;
  pluginId?: string;
  currentHash?: string;
  handlerType?: string;
  timeoutSec?: number;
  statusMessage?: string;
}

/**
 * Harness 启动前发现 hooks 尚未被信任：询问用户是否信任当前精确定义。
 * 这是启动信任，不是单次工具执行权限，故仍是独立 kind。
 */
export interface HookTrustApproval {
  kind: "hook_trust";
  harnessName: string;
  hooks: HookTrustCandidate[];
}


export type ApprovalDraft = PermissionApproval | HookTrustApproval;
export type ApprovalAnswer =
  | { kind: "permission"; outcome: "selected"; optionId: string }
  | { kind: "hook_trust"; outcome: "trusted" | "skipped" };
export type ApprovalCancellationReason = "user" | "requester" | "turn" | "timeout" | "recovery";
export type ApprovalResult = ApprovalAnswer | { kind: "cancelled"; reason: ApprovalCancellationReason; detail?: string };
