import { readExecutionContexts } from "./legacy.ts";
// 会话存储：~/.aide/sessions/<id>/。
// cwd 是执行环境，不参与 Session 的身份和存储定位；session.jsonl 承载统一逻辑历史，
// session/plugins/ 承载以该 AideSession 为 owner 的 Plugin 数据。
// HarnessSession 元数据只用于优先恢复 harness 私有状态，缺失时仍可从 AideSession 重建上下文。

import { createHash } from "node:crypto";
import { ResourceStorage } from "../resource/storage.ts";
import { assertSessionId } from "./session-id.ts";
import { invocationUserText } from "./message-relations.ts";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  type LogEntry,
  type LogLevel,
  logError,
  SessionLogger,
  type SessionLoggerOptions,
} from "../logging.ts";
import { newId } from "../event/ids.ts";
import {
  ENVELOPE_VERSION,
  textOf,
  type AnyEventDraft,
  type AnyEventEnvelope,
  type ContentBlock,
  type EventEnvelope,
  type EventKind,
  type NewEvent,
  type EventSource,
  type StopReason,
  type InvocationSummary,
  type InvocationSummaryToolCall,
  type UsageUpdate,
} from "../event/index.ts";
import { EventLedger } from "../event/ledger.ts";
import type { HarnessSessionIdentity } from "../harness/adapter.ts";
import {
  type HarnessSessionMeta,
  type ExecutionContextMeta,
} from "../execution-context.ts";
import { applyEvent, reduceEvents, type SessionState } from "./reduce.ts";

/** HarnessTarget-scoped preferences are shared across contexts, not by native sessions. */
export interface HarnessTargetMeta {
  harnessTargetId: string;
  harness: string;
  model?: string;
  effort?: string;
  mode?: string;
}

/** Session-level desired routing target. HarnessSession bindings remain context × Target owned. */
export interface SessionTargetBindingMeta {
  readonly targetId?: string;
  readonly generation: number;
  readonly resourceVersion: number;
  readonly updatedAt: string;
}

/** 0.2.21 and earlier stored Target preferences and one native binding together. */
export interface LegacyHarnessSessionMeta extends HarnessSessionMeta {
  harnessTargetId: string;
  model?: string;
  effort?: string;
  mode?: string;
}

/** fork 谱系：child 复制了哪个会话、复制到哪个事件水位（将来从消息 fork 时即边界）。 */
export interface SessionForkOrigin {
  aideSessionId: string;
  /** 源会话中被复制历史的最后一个事件 seq */
  throughSeq: number;
}

/** 从 HarnessSession 接入 Aide 时的不可变来源坐标。 */
export interface AdoptedHarnessSession {
  harnessTargetId: string;
  harness: string;
  identity: HarnessSessionIdentity;
}

/**
 * 某一段 Harness 历史前缀的内容边界。digest 覆盖从首轮到 turnCount 的完整语义投影，
 * 因而能发现早期工具/推理/计划事实被旁路改写，而不只比较最后一轮文本。
 */
export interface HarnessHistoryBoundary {
  /** digest 语义版本；算法或归一投影变化时递增，禁止拿不同版本直接比较。 */
  version: 1;
  turnId?: string;
  turnCount: number;
  prefixDigest: string;
}

export interface HarnessSessionAdoption {
  session: AdoptedHarnessSession;
  importedThrough: HarnessHistoryBoundary;
}

/** @deprecated 仅用于读取 0.2.14 及更早版本的 meta。 */
export interface NativeSessionOrigin {
  harnessTargetId: string;
  harness: string;
  nativeSessionId: string;
}

export interface SessionMeta {
  aideSessionId: string;
  /** Session 名称：可由用户显式指定；fork 未命名时由第一条 queue 补齐。 */
  title?: string;
  /** 第一条真实用户输入的紧凑预览，只写一次；供 resume/list/@ 发现会话。 */
  preview?: string;
  /** 会话名称之外的补充说明；fork session 用它快照来源会话。 */
  description?: string;
  cwd: string;
  createdAt: string;
  updatedAt?: string;
  /** harnessTargetId → shared Target preferences. */
  harnessTargets: Record<string, HarnessTargetMeta>;
  /** Core-owned desired route exposed as SessionTargetBinding. */
  targetBinding?: SessionTargetBindingMeta;
  /** Aide-native task lines. A context may traverse multiple HarnessTargets. */
  contexts: Record<string, ExecutionContextMeta>;
  /** @deprecated in-memory compatibility projection; omitted from new meta.json writes. */
  harnessSessions: Record<string, LegacyHarnessSessionMeta>;
  forkedFrom?: SessionForkOrigin;
  /** 首次 adoption 的 HarnessSession 永不随当前执行 binding 改写。 */
  adoptedFrom?: HarnessSessionAdoption;
  /** @deprecated 读取时迁移到 adoptedFrom；新写入不再产生。 */
  nativeSessionOrigin?: NativeSessionOrigin;
}

export interface SessionCleanupFailure {
  aideSessionId: string;
  cwd: string;
  error: string;
}

export interface SessionCleanupResult {
  removed: SessionMeta[];
  skippedActive: SessionMeta[];
  failures: SessionCleanupFailure[];
}

interface StoredSession {
  dir: string;
  meta: SessionMeta;
}

export function sessionTargetBindingMeta(
  meta: Pick<SessionMeta, "createdAt" | "targetBinding">,
): SessionTargetBindingMeta {
  return meta.targetBinding ?? Object.freeze({
    generation: 1,
    resourceVersion: 1,
    updatedAt: meta.createdAt,
  });
}

const SESSION_PREVIEW_MAX_CHARS = 100;
const SESSION_PREVIEW_SCAN_BYTES = 256 * 1024;

/** 对齐 Codex resume：取第一条有效用户输入的首个非空行，并做有界字符截断。 */
export function sessionPreview(text: string): string | undefined {
  const firstLine = stripAideInjectedContext(text)
    .split(/\r?\n/)
    // chat-tui 的图片粘贴目前以本地路径进入文本；它是附件，不是可辨识的会话名称。
    .map((line) =>
      line
        .trim()
        .replace(/^\/\S+\.(?:avif|bmp|gif|jpe?g|png|tiff?|webp)(?:\s+|$)/i, "")
        .trim(),
    )
    .find(Boolean);
  if (!firstLine) return undefined;
  const chars = [...firstLine];
  return chars.length <= SESSION_PREVIEW_MAX_CHARS
    ? firstLine
    : `${chars.slice(0, SESSION_PREVIEW_MAX_CHARS - 3).join("")}...`;
}

/** 旧版本自动写入的标题不是用户命名，展示时应让位给 conversation preview。 */
function explicitSessionTitle(meta: SessionMeta): string | undefined {
  const title = meta.title?.trim();
  if (!title) return undefined;
  // 冻结的 legacy 集合：匹配的是历史版本写入的自动标题，刻意不从 harness registry
  // 派生——将来新增 harness 不会产生这种标题，跟随 registry 反而会误伤同名用户标题。
  const generated = ["chat", "codex", "claude", "claude-code"].flatMap((agent) => {
    const base = `${agent} @ ${meta.cwd}`;
    return [base, `${base} (fork)`];
  });
  return generated.includes(title) ? undefined : title;
}

export function sessionDisplayTitle(meta: SessionMeta): string {
  const explicitTitle = explicitSessionTitle(meta);
  if (meta.forkedFrom) {
    return explicitTitle ?? meta.description?.trim() ?? `fork: chat @ ${meta.cwd}`;
  }
  return explicitTitle ?? meta.preview?.trim() ?? meta.description?.trim() ?? `chat @ ${meta.cwd}`;
}

function normalizeSessionMeta(meta: SessionMeta): SessionMeta {
  const { lanes: _legacyLanes, ...current } = meta as SessionMeta & { lanes?: unknown };
  return { ...current, harnessTargets: meta.harnessTargets ?? {}, contexts: readExecutionContexts(meta), harnessSessions: {} };
}

export interface NativeSessionMaterialization {
  harnessTargetId: string;
  harness: string;
  nativeSessionId: string;
  cwd: string;
  title?: string;
  turns: HarnessHistoryTurn[];
}

export interface HarnessHistoryEvent {
  source: "user" | "aide" | "harness";
  event: AnyEventDraft;
}

export interface HarnessHistoryTurn {
  /** Harness 中该 turn 的稳定 id；旧 Provider 缺失时用快照内位置兼容。 */
  turnId?: string;
  userText?: string;
  agentText?: string;
  /** Harness 已归一的完整 turn；缺省时兼容只提供 user/assistant 文本的 provider。 */
  events?: HarnessHistoryEvent[];
}

export interface HarnessSessionAdoptionSource {
  session: AdoptedHarnessSession;
  cwd: string;
  title?: string;
  turns: HarnessHistoryTurn[];
  observedThrough: HarnessHistoryBoundary;
}

/** @deprecated 0.2.14 public type aliases. */
export type NativeSessionMaterializationEvent = HarnessHistoryEvent;
export type NativeSessionMaterializationTurn = HarnessHistoryTurn;

function previewFromSessionLog(dir: string): string | undefined {
  const path = join(dir, "session.jsonl");
  if (!existsSync(path)) return undefined;
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(SESSION_PREVIEW_SCAN_BYTES);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8", 0, bytes);
    const lastNewline = text.lastIndexOf("\n");
    const complete = bytes < buffer.length ? text : lastNewline >= 0 ? text.slice(0, lastNewline) : "";
    for (const line of complete.split("\n")) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as AnyEventEnvelope;
        if (event.kind !== "user_message" || event.source.type === "plugin") {
          continue;
        }
        const payload = event.payload as { content?: ContentBlock[] };
        const preview = sessionPreview(textOf(payload.content ?? []));
        if (preview) return preview;
      } catch {
        // 有界扫描只用于旧会话的展示回填；单行损坏不应让整个 session picker 失败。
      }
    }
  } finally {
    closeSync(fd);
  }
  return undefined;
}

function withSessionPreview(dir: string, meta: SessionMeta): SessionMeta {
  if (meta.preview?.trim()) return meta;
  const preview = previewFromSessionLog(dir);
  return preview ? { ...meta, preview } : meta;
}

/**
 * @spec Sessions persist execution history, contexts and native bindings; cwd never partitions their identity or storage.
 * @link component://docs/kernel.md
 */
function journalDirectory(home: string, id: string): string {
  assertSessionId(id);
  const directory = /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) ? id : `~${createHash("sha256").update(id).digest("hex")}`;
  return join(home, "sessions", directory);
}

/** @spec Open the application execution journal without discovering or creating resource owners.
 * @why Existing journal paths and envelopes remain readable across upgrades; their old Session spelling is private storage compatibility.
 */
export function openExecutionJournal(home: string, cwd: string): SessionHandle {
  const id = "aide:execution";
  const dir = journalDirectory(home, id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "meta.json");
  const meta: SessionMeta = existsSync(path)
    ? normalizeSessionMeta(JSON.parse(readFileSync(path, "utf8")))
    : { aideSessionId: id, cwd: resolve(cwd), createdAt: new Date().toISOString(), harnessTargets: {}, contexts: {}, harnessSessions: {} };
  if (!existsSync(path)) writeMetaAtomic(dir, meta);
  return new SessionHandle(id, dir, meta);
}

export class SessionStore {
  readonly rootDir: string;
  private readonly loggerOptions: SessionLoggerOptions;

  constructor(
    rootDir?: string,
    loggerOptions: { readonly level?: LogLevel } = {},
  ) {
    this.rootDir = rootDir ?? join(homedir(), ".aide");
    this.loggerOptions = loggerOptions;
  }

  createSession(opts: { id?: string; cwd: string; title?: string }): SessionHandle {
    const id = opts.id ?? newId("bs");
    const cwd = resolve(opts.cwd);
    const dir = this.sessionDir(id);
    mkdirSync(dir, { recursive: true });
    if (existsSync(join(dir, "meta.json"))) throw new Error(`aide session already exists: ${id}`);
    const meta: SessionMeta = {
      aideSessionId: id,
      title: opts.title,
      cwd,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      harnessTargets: {},
      contexts: {},
      harnessSessions: {},
    };
    writeMetaAtomic(dir, meta);
    return new SessionHandle(id, dir, meta, this.loggerOptions);
  }

  /** Session id locates its directory directly, independent of execution cwd. */
  openSession(id: string): SessionHandle {
    const dir = this.sessionDir(id);
    const metaPath = join(dir, "meta.json");
    if (!existsSync(metaPath)) throw new Error(`aide session not found: ${id}`);
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta & {
      mainLaneId?: unknown;
    };
    const meta = withSessionPreview(dir, normalizeSessionMeta(parsed));
    if (
      parsed.harnessSessions ||
      !parsed.harnessTargets ||
      !parsed.contexts ||
      parsed.mainLaneId !== undefined
    ) {
      writeMetaAtomic(dir, meta);
    }
    return new SessionHandle(id, dir, meta, this.loggerOptions);
  }

  listSessions(): SessionMeta[] {
    return this.listStoredSessions().map(({ meta }) => meta);
  }

  private listStoredSessions(): StoredSession[] {
    const sessionsDir = join(this.rootDir, "sessions");
    if (!existsSync(sessionsDir)) return [];
    const out: StoredSession[] = [];
    for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sessionDir = join(sessionsDir, entry.name);
      const metaPath = join(sessionDir, "meta.json");
      if (!existsSync(metaPath)) continue;
      try {
        const meta = withSessionPreview(
          sessionDir,
          normalizeSessionMeta(JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta),
        );
        out.push({ dir: sessionDir, meta });
      } catch {
        // 损坏的 meta 不阻塞列表
      }
    }
    out.sort((a, b) =>
      (b.meta.updatedAt ?? b.meta.createdAt).localeCompare(
        a.meta.updatedAt ?? a.meta.createdAt,
      )
    );
    return out;
  }

  /**
   * Permanently remove sessions whose last persisted activity is older than `before`.
   *
   * Cleanup takes the same per-session lock as open/resume before deleting the session
   * directory. A live session is skipped, and metadata is read again after locking so a
   * session that became active during discovery cannot be removed from a stale snapshot.
   */
  cleanSessions(opts: { before: Date }): SessionCleanupResult {
    if (Number.isNaN(opts.before.getTime())) {
      throw new Error("session cleanup cutoff must be a valid Date");
    }
    const cutoff = opts.before.getTime();
    const result: SessionCleanupResult = {
      removed: [],
      skippedActive: [],
      failures: [],
    };
    const candidates = this.listStoredSessions();

    for (const { dir, meta: candidate } of candidates) {
      const observedActivity = Date.parse(candidate.updatedAt ?? candidate.createdAt);
      if (!Number.isFinite(observedActivity) || observedActivity >= cutoff) continue;

      if (dir !== this.sessionDir(candidate.aideSessionId)) {
        result.failures.push({
          aideSessionId: candidate.aideSessionId,
          cwd: candidate.cwd,
          error: "session directory and metadata identity do not match",
        });
        continue;
      }
      const lockPath = join(dir, "lock");
      if (sessionLockIsActive(lockPath)) {
        result.skippedActive.push(candidate);
        continue;
      }

      let ownsLock = false;
      try {
        ownsLock = acquireSessionLock(lockPath, candidate.aideSessionId);
        if (!ownsLock) {
          result.skippedActive.push(candidate);
          continue;
        }

        const persisted = JSON.parse(
          readFileSync(join(dir, "meta.json"), "utf8"),
        ) as SessionMeta;
        if (persisted.aideSessionId !== candidate.aideSessionId) {
          throw new Error("session metadata identity changed during cleanup");
        }
        const latestActivity = Date.parse(persisted.updatedAt ?? persisted.createdAt);
        if (!Number.isFinite(latestActivity)) {
          throw new Error("session metadata has no valid activity timestamp");
        }
        if (latestActivity >= cutoff) continue;

        // Remove the reopenable Session before its business state; a filesystem failure must retain Resources.
        rmSync(dir, { recursive: true });
        ownsLock = false;
        if (existsSync(join(this.rootDir, "resources.sqlite"))) ResourceStorage.open(this.rootDir).removeSession(candidate.aideSessionId);
        result.removed.push(normalizeSessionMeta(persisted));
      } catch (error) {
        if (error instanceof SessionInUseError) {
          result.skippedActive.push(candidate);
        } else {
          result.failures.push({
            aideSessionId: candidate.aideSessionId,
            cwd: candidate.cwd,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        if (ownsLock) releaseSessionLock(lockPath);
      }
    }

    return result;
  }

  /** Read-only liveness observation for Session Resource projection. */
  isSessionActive(meta: Pick<SessionMeta, "aideSessionId">): boolean {
    const path = join(this.sessionDir(meta.aideSessionId), "lock");
    return sessionLockIsActive(path);
  }

  private sessionDir(sessionId: string): string {
    return journalDirectory(this.rootDir, sessionId);
  }
}

function writeMetaAtomic(dir: string, meta: SessionMeta): void {
  const tmp = join(dir, "meta.json.tmp");
  const { harnessSessions: _compatibilityProjection, ...persisted } = meta;
  writeFileSync(tmp, JSON.stringify(persisted, null, 2));
  renameSync(tmp, join(dir, "meta.json"));
}

export class SessionHandle {
  readonly id: string;
  readonly dir: string;
  readonly logger: SessionLogger;
  readonly ledger: EventLedger;
  private readonly eventListeners = new Set<(event: AnyEventEnvelope) => void>();
  private state: SessionState;
  private nextEventSeq: number;
  meta: SessionMeta;

  constructor(
    id: string,
    dir: string,
    meta: SessionMeta,
    loggerOptions: SessionLoggerOptions = {},
  ) {
    this.id = id;
    this.dir = dir;
    this.meta = normalizeSessionMeta(meta);
    this.logger = new SessionLogger(
      join(this.dir, "session.log"),
      this.id,
      loggerOptions,
    );
    this.ledger = new EventLedger({
      path: join(this.dir, "session.jsonl"),
      log: (entry) => this.log(entry),
    });
    const history = this.ledger.read();
    this.state = reduceEvents(history);
    this.nextEventSeq = (history.at(-1)?.seq ?? 0) + 1;
  }

  /** Current Core projection. Live events and replay both use the same reducer. */
  get projection(): SessionState {
    return this.state;
  }

  /** Observe accepted Session events after they have been recorded and reduced. */
  subscribe(listener: (event: AnyEventEnvelope) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * AideSession 的统一 Event 入口。当前策略先完成 WAL record，再直接 reduce；
   * Ledger 只是 Recorder，不承担实时分发。
   */
  appendEvent<K extends EventKind>(event: NewEvent<K>): EventEnvelope<K> {
    // Harness-originated facts already carry the exact Target identity in their
    // source. Preserve it as the execution coordinate when a direct/legacy
    // producer omitted the top-level field; never infer a Target from a Harness
    // family name. An explicit coordinate remains authoritative.
    const harnessTargetId =
      event.harnessTargetId ??
      (event.source.type === "harness"
        ? event.source.harnessTargetId
        : undefined);
    const envelope: EventEnvelope<K> = {
      v: ENVELOPE_VERSION,
      eventId: newId("ev"),
      ts: new Date().toISOString(),
      seq: this.nextEventSeq,
      scope: { type: "session", aideSessionId: this.id },
      ...event,
      ...(harnessTargetId === undefined ? {} : { harnessTargetId }),
    };
    this.ledger.record(envelope);
    this.nextEventSeq += 1;
    applyEvent(this.state, envelope as AnyEventEnvelope);
    for (const listener of this.eventListeners) {
      try {
        listener(envelope as AnyEventEnvelope);
      } catch (error) {
        this.log({
          level: "error",
          source: "aide",
          component: "session.event",
          message: "AideSession event listener threw",
          error: logError(error),
          attributes: { seq: envelope.seq, kind: envelope.kind },
        });
      }
    }
    return envelope;
  }

  /**
   * Structured operational logs are deliberately separate from the event ledger:
   * they support diagnosis, not replay or product state.
   */
  log(entry: LogEntry): void {
    this.logger.log(entry);
  }

  async flushLogs(): Promise<void> {
    await this.logger.flush();
  }

  async closeLogs(): Promise<void> {
    await this.logger.close();
  }

  /**
   * Provider 原生入站消息的旁路 NDJSON。与 session.log 分开，避免高频 wire trace
   * 淹没错误诊断；单文件到 10 MiB 后保留一份上一代。失败不影响正典事件流。
   */
  nativeEvent(
    harnessTargetId: string,
    harness: string,
    event: { direction: "in"; name?: string; payload: unknown },
    contextId?: string,
  ): void {
    try {
      const safeTarget = harnessTargetId.replace(/[^a-zA-Z0-9._-]/g, "-");
      const safeContext = contextId?.replace(/[^a-zA-Z0-9._-]/g, "-");
      const path = join(
        this.dir,
        `native-${safeTarget}${safeContext ? `-${safeContext}` : ""}.jsonl`,
      );
      if (existsSync(path) && statSync(path).size >= 10 * 1024 * 1024) {
        renameSync(path, `${path}.1`);
        chmodSync(`${path}.1`, 0o600);
      }
      appendFileSync(
        path,
        `${JSON.stringify({
          ts: new Date().toISOString(),
          aideSessionId: this.id,
          harnessTargetId,
          ...(contextId ? { contextId } : {}),
          harness,
          ...event,
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      chmodSync(path, 0o600);
    } catch {
      // 原生 trace 只服务协议排障，不能反向影响 Harness 执行。
    }
  }

  private lockPath(): string {
    return join(this.dir, "lock");
  }

  /**
   * 会话独占锁（pid 文件）。存在的意义是给 crash recovery 提供写入前提：
   * "最后事件是 running"只有在没有活进程持有会话时才能断定为崩溃残留，
   * 否则往活会话里合成终态会污染它。不承担并发追加的完整保护。
   * 同进程重入直接通过，且不做引用计数——约定同一进程内一个 session 至多
   * 一个活 handle（TUI 单前台会话；将来多 Session Controller 由 session slot
   * 唯一性保证），进程内并发归上层，锁只管跨进程。返回 true 表示本次新建了锁，
   * 调用方应负责释放；false 表示同进程已持有，不能替原 owner 释放。
   */
  acquireLock(): boolean {
    return acquireSessionLock(this.lockPath(), this.id);
  }

  /** 只释放自己持有的锁；释放失败不阻塞退出（stale 锁由下次 acquire 的存活判定接管）。 */
  releaseLock(): void {
    releaseSessionLock(this.lockPath());
  }

  loadState(): SessionState {
    return reduceEvents(this.ledger.read());
  }

  updateMeta(patch: Partial<Omit<SessionMeta, "aideSessionId">>): void {
    this.meta = normalizeSessionMeta({ ...this.meta, ...patch });
    writeMetaAtomic(this.dir, this.meta);
  }

  setPreviewIfEmpty(text: string): void {
    if (this.meta.preview?.trim()) return;
    const preview = sessionPreview(text);
    if (preview) this.updateMeta({ preview });
  }

  setTitleIfEmpty(text: string): void {
    if (this.meta.title?.trim()) return;
    const title = sessionPreview(text);
    if (title) this.updateMeta({ title });
  }

  setHarnessTarget(harnessTargetId: string, target: HarnessTargetMeta): void {
    if (target.harnessTargetId !== harnessTargetId) {
      throw new Error(
        `harness target key mismatch: key=${harnessTargetId}, meta=${target.harnessTargetId}`,
      );
    }
    this.meta.harnessTargets = {
      ...this.meta.harnessTargets,
      [harnessTargetId]: target,
    };
    this.meta = normalizeSessionMeta(this.meta);
    writeMetaAtomic(this.dir, this.meta);
  }

  setExecutionContext(contextId: string, context: ExecutionContextMeta): void {
    if (context.contextId !== contextId) {
      throw new Error(
        `context key mismatch: key=${contextId}, meta=${context.contextId}`,
      );
    }
    this.meta.contexts = { ...this.meta.contexts, [contextId]: context };
    this.meta = normalizeSessionMeta(this.meta);
    writeMetaAtomic(this.dir, this.meta);
  }

  setContextHarnessSession(
    contextId: string,
    harnessTargetId: string,
    harnessSession: HarnessSessionMeta,
  ): void {
    const context = this.meta.contexts[contextId];
    if (!context) throw new Error(`Execution context not found: ${contextId}`);
    this.setExecutionContext(contextId, {
      ...context,
      harnessSessions: {
        ...context.harnessSessions,
        [harnessTargetId]: harnessSession,
      },
    });
  }

  requireExecutionContext(contextId: string): ExecutionContextMeta {
    const context = this.meta.contexts[contextId];
    if (!context) throw new Error(`Execution context not found: ${contextId}`);
    return context;
  }

  /**
   * 汇总一次调用并落盘 _aide_invocation_summary 事件。
   * 幂等：同一 invocationId 已有 summary 时直接返回已有的，不重复追加。
   */
  summarizeInvocation(invocationId: string): InvocationSummary {
    return this.summarizeInvocationEvent(invocationId).payload;
  }

  /** 与 summarizeInvocation 相同，但返回 envelope，供 live reducer 消费实际落盘事件。 */
  summarizeInvocationEvent(invocationId: string): EventEnvelope<"_aide_invocation_summary"> {
    const events = this.ledger.read();
    const existing = events.find(
      (e): e is EventEnvelope<"_aide_invocation_summary"> =>
        e.kind === "_aide_invocation_summary" && e.payload.invocationId === invocationId,
    );
    if (existing) return existing;

    const invocationEvents = events.filter((e) => e.invocationId === invocationId);
    if (invocationEvents.length === 0) {
      throw new Error(`no events for invocation ${invocationId} in session ${this.id}`);
    }
    const state = reduceEvents(invocationEvents);

    // 自动注入块保留在原始事件里供审计，但不能进入摘要后再次被下一棒递归放大。
    // A native queue can consume a body recorded in an earlier Turn. Resolve
    // messages from the Session projection, then select their actual ownership;
    // filtering the ledger first would discard the body or its consumption fact.
    const messages = this.loadState();
    const userText = invocationUserText(messages, invocationId);
    const agentText = invocationAgentText(messages, invocationId);
    const finalText = invocationAgentText(messages, invocationId, "final");
    const toolCalls: InvocationSummaryToolCall[] = [...state.toolCalls.values()].map((tc) => ({
      toolCallId: tc.toolCallId,
      title: tc.title,
      kind: tc.kind,
      status: tc.status,
    }));
    const usage: UsageUpdate | undefined =
      state.usage.inputTokens || state.usage.outputTokens
        ? {
            inputTokens: state.usage.inputTokens,
            outputTokens: state.usage.outputTokens,
            cacheReadTokens: state.usage.cacheReadTokens,
            cacheWriteTokens: state.usage.cacheWriteTokens,
            reasoningTokens: state.usage.reasoningTokens,
            isEstimated: state.usage.hasEstimated,
          }
        : undefined;

    const summary: InvocationSummary = {
      invocationId: invocationId,
      // per-turn 取值：输入虽已按 turnId 过滤，但显式按 turn 取让它对"过滤集混入
      // 他人终态"的任何未来变化免疫（无 turnId 的迟到终态只会进 lastStopReason）
      stopReason: (state.stopReasons.get(invocationId) ?? state.lastStopReason) as StopReason | undefined,
      userText: userText || undefined,
      agentText: agentText || undefined,
      finalText: finalText || undefined,
      toolCalls,
      usage,
      startedAt: invocationEvents[0]?.ts,
      endedAt: invocationEvents[invocationEvents.length - 1]?.ts,
    };
    const harness = invocationEvents[0]?.harness ?? "aide";
    const harnessTargetId = invocationEvents.find((event) => event.harnessTargetId)?.harnessTargetId;
    const contextId = invocationEvents.find((event) => event.contextId)?.contextId;
    const event = this.appendEvent({
      kind: "_aide_invocation_summary",
      source: { type: "aide" },
      payload: summary,
      harness,
      ...(harnessTargetId ? { harnessTargetId } : {}),
      ...(contextId ? { contextId } : {}),
      invocationId: invocationId,
    }) as EventEnvelope<"_aide_invocation_summary">;
    this.updateMeta({ updatedAt: summary.endedAt ?? new Date().toISOString() });
    return event;
  }
}

const HISTORY_OPERATIONAL_KINDS = new Set<EventKind>([
  "_aide_invocation_summary",
  "_aide_delivery_attempt_update",
  "_aide_context_snapshot",
  "_aide_context_delivery_receipt",
  "_aide_queue_reordered",
]);

function canonicalHistoryValue(value: unknown, key?: string): unknown {
  // Aide 和 Harness 各自签发的局部 ID、时间戳不属于历史语义；保留它们会让同一事实
  // 因承载坐标不同而误报 divergence。
  if (key && (/Id$/.test(key) || key === "ts" || key.endsWith("At"))) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => canonicalHistoryValue(item));
  }
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const normalized = canonicalHistoryValue(entryValue, entryKey);
    if (normalized !== undefined) out[entryKey] = normalized;
  }
  return out;
}

function historyTurnProjection(turn: HarnessHistoryTurn): unknown {
  return {
    userText: comparableTurnText(turn.userText) || undefined,
    agentText: comparableTurnText(turn.agentText) || undefined,
    events: turn.events?.map(({ source, event }) => ({
      source,
      kind: event.kind,
      payload: canonicalHistoryValue(event.payload),
    })),
  };
}

function harnessHistoryTurnDigest(turn: HarnessHistoryTurn): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalHistoryValue(historyTurnProjection(turn))))
    .digest("hex");
}

export function harnessHistoryBoundary(
  turns: readonly HarnessHistoryTurn[],
  throughCount = turns.length,
): HarnessHistoryBoundary {
  const prefix = turns.slice(0, throughCount);
  return {
    version: 1,
    turnId: prefix.at(-1)?.turnId,
    turnCount: prefix.length,
    prefixDigest: createHash("sha256")
      .update(JSON.stringify(prefix.map(historyTurnProjection)))
      .digest("hex"),
  };
}

function assertObservedBoundary(source: HarnessSessionAdoptionSource): void {
  const calculated = harnessHistoryBoundary(source.turns);
  if (
    calculated.version !== source.observedThrough.version ||
    calculated.turnCount !== source.observedThrough.turnCount ||
    calculated.turnId !== source.observedThrough.turnId ||
    calculated.prefixDigest !== source.observedThrough.prefixDigest
  ) {
    throw new Error(
      `invalid HarnessHistoryBoundary for ` +
        `${source.session.harnessTargetId}/${source.session.identity.id}`,
    );
  }
}

function adoptionFor(meta: SessionMeta): HarnessSessionAdoption | undefined {
  if (meta.adoptedFrom) return meta.adoptedFrom;
  if (!meta.nativeSessionOrigin) return undefined;
  return {
    session: {
      harnessTargetId: meta.nativeSessionOrigin.harnessTargetId,
      harness: meta.nativeSessionOrigin.harness,
      identity: { id: meta.nativeSessionOrigin.nativeSessionId },
    },
    // 旧 meta 没保存内容边界；首次刷新仍会和已落盘的完整 turn 做逐轮对账，成功后升级。
    importedThrough: harnessHistoryBoundary([]),
  };
}

function materializedHistoryTurns(
  session: SessionHandle,
  summaries: readonly EventEnvelope<"_aide_invocation_summary">[],
): HarnessHistoryTurn[] {
  const events = session.ledger.read();
  // 新事件流里 steer 的投递事实在 input_delivery_update；未证应用的 steer 内容不进历史。
  const appliedSteers = new Set<string>();
  for (const event of events) {
    if (event.kind === "input_delivery_update" && event.payload.state === "applied") {
      appliedSteers.add(event.payload.messageId);
    }
  }
  return summaries.map((summary) => ({
    turnId: summary.invocationId,
    userText: summary.payload.userText,
    agentText: summary.payload.agentText,
    events: events.flatMap((event): HarnessHistoryEvent[] => {
      if (
        event.invocationId !== summary.invocationId ||
        event.seq >= summary.seq ||
        HISTORY_OPERATIONAL_KINDS.has(event.kind) ||
        (event.kind === "user_message" &&
          event.payload.delivery === "steer" &&
          (event.payload.deliveryState !== undefined
            ? // Legacy 补丁语义不变：状态补丁事件本身不进历史，applied 补丁进。
              event.payload.deliveryState !== "applied"
            : !appliedSteers.has(event.payload.messageId)))
      ) {
        return [];
      }
      const source =
        event.source.type === "user"
          ? "user"
          : event.source.type === "harness"
            ? "harness"
            : "aide";
      return [{
        source,
        event: {
          kind: event.kind,
          payload: event.payload,
        } as AnyEventDraft,
      }];
    }),
  }));
}

class SessionInUseError extends Error {
  override readonly name = "SessionInUseError";
}

function sessionLockIsActive(path: string): boolean {
  try {
    const holder = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(holder) && holder > 0 && pidAlive(holder);
  } catch {
    return false;
  }
}

function acquireSessionLock(path: string, sessionId: string): boolean {
  // Each attempt either atomically creates the lock or rules out one stale holder.
  // Avoid existsSync before open: the gap between those operations is a TOCTOU race.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let holder: number;
    try {
      holder = Number(readFileSync(path, "utf8").trim());
    } catch {
      continue; // The holder released between open and read; retry the atomic create.
    }
    if (holder === process.pid) return false;
    if (Number.isFinite(holder) && holder > 0 && pidAlive(holder)) {
      throw new SessionInUseError(
        `aide session ${sessionId} is in use by another aide process (pid ${holder})`,
      );
    }
    rmSync(path, { force: true });
  }
  throw new Error(`failed to acquire session lock for ${sessionId} after retries`);
}

function releaseSessionLock(path: string): void {
  try {
    if (existsSync(path) && readFileSync(path, "utf8").trim() === String(process.pid)) {
      rmSync(path);
    }
  } catch {
    // A stale lock is safer than throwing during shutdown; the next acquire detects it.
  }
}

/** kill(pid, 0) 探活：EPERM 表示进程存在但无权限发信号，同样算活。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function invocationAgentText(state: SessionState, invocationId: string, phase?: "final"): string {
  const parts: string[] = [];
  for (const item of state.timeline) {
    if (item.type !== "message") continue;
    const msg = state.messages.get(item.id);
    if (msg && msg.role === "agent" && msg.invocationId === invocationId) {
      if (phase && msg.phase !== phase) continue;
      const text = textOf(msg.content);
      if (text) parts.push(text);
    }
  }
  return parts.join("\n");
}

function materializedEventSource(
  source: HarnessHistoryEvent["source"],
  harnessTargetId: string,
): EventSource {
  switch (source) {
    case "user":
      return { type: "user" };
    case "aide":
      return { type: "aide" };
    case "harness":
      return { type: "harness", harnessTargetId };
  }
}

function comparableTurnText(text: string | undefined): string {
  return text?.replace(/\r\n/g, "\n").replace(/\n{2,}/g, "\n").trim() ?? "";
}

function stripAideInjectedContext(text: string): string {
  return text.replace(/<aide-(context|sync)>[\s\S]*?<\/aide-\1>\s*/g, "").trim();
}
