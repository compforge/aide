import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import { SessionManager, parseSessionEntries, type AgentSession } from "@earendil-works/pi-coding-agent";
import { PiObservation, observationWriter, readObservation, sessionView } from "@compforge/agent-pi/observation";
import type { PiConfig } from "../../src/host/harness/pi/config.ts";

export const ObservationConfigSchema = z.object({
  captureRequests: z.boolean().default(false),
  maxSessionBytes: z.number().int().min(1024).default(16 * 1024 * 1024),
  maxBytes: z.number().int().min(1024).default(256 * 1024 * 1024),
}).strict().refine(c => c.maxSessionBytes <= c.maxBytes, { message: "maxSessionBytes must not exceed maxBytes" });

/**
 * @spec Pi owns execution bodies and recovery. This directory holds optional bounded supplements only.
 * @spec Active writers reserve capacity; inactive files count at actual size. Full disks/budgets stop capture, never business execution.
 * @why Reservations prevent concurrent sessions from each spending the same remaining disk budget. No automatic deletion of evidence.
 * @link docs/observation.md
 */
export class PiObservations {
  private readonly reservations = new Map<string, number>();
  constructor(readonly directory: string, private readonly config: z.infer<typeof ObservationConfigSchema>, private readonly log: Pick<Logger, "warn">) {}
  private path(id: string) { return join(this.directory, `${createHash("sha256").update(id).digest("hex")}.jsonl`); }
  open(manager: SessionManager): { manager: SessionManager; bind(session: AgentSession): void; close(): void } {
    const nativeOnly = { manager, bind() {}, close() {} };
    if (!this.config.captureRequests) return nativeOnly;
    const sessionId = manager.getSessionId(), path = this.path(sessionId);
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if (this.reservations.has(path)) throw new Error("Session observation already active");
      const used = readdirSync(this.directory).filter(f => f.endsWith(".jsonl")).reduce((total, f) => {
        const file = join(this.directory, f);
        return total + (file === path || this.reservations.has(file) ? 0 : statSync(file).size);
      }, 0) + [...this.reservations.values()].reduce((a, b) => a + b, 0);
      const allowance = Math.min(this.config.maxSessionBytes, this.config.maxBytes - used);
      if (allowance < 1024 || (existsSync(path) && statSync(path).size >= allowance)) throw new Error("Observation disk budget exhausted");
      const write = observationWriter(path, { maxBytes: allowance });
      this.reservations.set(path, allowance);
      let stopped = false;
      const observer = new PiObservation({ sessionId, write: record => { if (!stopped) write(record); }, onError: error => {
        stopped = true;
        this.log.warn({ sessionId, error: error.message }, "Pi observation capture stopped or incomplete");
      } });
      let closed = false;
      const close = () => { if (!closed) { closed = true; this.reservations.delete(path); } };
      return { manager: observer.storage(manager), close, bind: session => {
        session.agent.streamFunction = observer.stream(session.agent.streamFunction);
        session.agent.beforeToolCall = observer.beforeToolCall(session.agent.beforeToolCall);
        const unsubscribe = session.agent.subscribe(event => observer.event(event));
        const dispose = session.dispose.bind(session);
        session.dispose = () => { unsubscribe(); close(); dispose(); };
      } };
    } catch (error) {
      this.log.warn({ sessionId, error: String(error) }, "Pi observation unavailable; native session remains authoritative");
      return nativeOnly;
    }
  }
  async read(cwd: string, config: Pick<PiConfig, "agentDir">, sessionId: string) {
    const file = SessionManager.findById(resolve(cwd), sessionId, join(config.agentDir, "sessions"));
    if (!file) throw new Error("Native Pi session is missing");
    // @spec Observation never opens a writable manager: SDK open() may migrate and rewrite recovery files.
    const text = readFileSync(file, "utf8"), entries = parseSessionEntries(text);
    const header = entries[0];
    if (header?.type !== "session" || header.id !== sessionId || resolve(header.cwd) !== resolve(cwd)) throw new Error("Native Pi session identity mismatch");
    const path = this.path(sessionId);
    let supplement;
    let issue: string | undefined;
    try { supplement = readObservation(path, sessionId); }
    catch { issue = "Supplemental provider requests are unavailable; native history does not reconstruct the exact request/background."; }
    const view = sessionView(header, entries.filter(e => e.type !== "session"), supplement);
    if (entries.length !== text.split("\n").filter(line => line.trim()).length)
      view.issues = [...(view.issues ?? []), "Native Session contains malformed or incomplete records; only parsed entries are shown."];
    if (issue) view.issues = [...(view.issues ?? []), issue];
    return view;
  }
}
