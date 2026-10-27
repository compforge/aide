import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PluginContext } from "@compforge/aide-plugin";
import { Aide, type AideOptions } from "../../src/app.ts";
import { ConfigSchema } from "../../src/config.ts";
import { PiAdapter } from "../../src/host/harness/pi/adapter.ts";
import type { PiConfig } from "../../src/host/harness/pi/config.ts";
import { emptyConnectors } from "../../src/connector-client.ts";
import { inputDetail } from "../../src/api/inputs.ts";
import { MESSAGE_KINDS, MessageWatchSchema, type MessageWatch } from "../../plugins/personal/source/message/config.ts";
import { MESSAGE_SOURCE_TYPE, observeMessages, type MessageSourceStatus } from "../../plugins/personal/source/message/observe.ts";
import { WEAVE_TYPE, type WeaveStatus } from "../../plugins/personal/weave/model.ts";
import { SnapshotMessages, triggerMessages, type Snapshot } from "./snapshot.ts";
import { ReplayTimeoutSchema, settleMs } from "./config.ts";

export const replayTools = new Set([
  "read_input", "assess_input", "say", "summarize_topic", "list_topics", "read_topic", "group_topics", "route_input",
  "list_persons", "read_person", "summary_person", "list_work", "read_work", "list_connectors",
  "read_chat_messages", "read_thread_messages", "memory_search", "session_search",
]);

/** @spec Only snapshot reads and local Personal mutations are callable. No native filesystem/shell, work mutation or external delivery.
 * @why Source text is untrusted; a prompt instruction is not an isolation boundary.
 * @link docs/e2e-lark-replay.md
 */
export function restrictSession(session: AgentSession) {
  session.setActiveToolsByName(session.getAllTools().map(t => t.name).filter(name => replayTools.has(name)));
  return session;
}

export interface ReplayOptions {
  directory: string; weave: boolean; batchSize: number; timeoutMs: number;
  revision: string; datasetHash: string; model?: PiConfig;
  /** Test-only protocol replacement; CLI always uses the real Pi adapter. */
  createAdapter?: AideOptions["createAdapter"];
}

export async function replay(snapshot: Snapshot, options: ReplayOptions) {
  const timeoutMs = ReplayTimeoutSchema.parse(options.timeoutMs);
  const messages = new SnapshotMessages(snapshot), { directory } = options;
  const destination = pino.destination({ dest: join(directory, "replay.log"), sync: true });
  const log = pino(destination);
  const connectors = { ...emptyConnectors, messages, describe: async () => ({ environments: [], requirements: [], forges: [],
    messages: { provider: "lark" as const, ...snapshot.identity } }) };
  const usage: Record<string, { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }> = {};
  const eventsPath = join(directory, "events.jsonl");
  const append = (event: unknown) => appendFileSync(eventsPath, JSON.stringify(event) + "\n", { mode: 0o600 });
  const aide: Aide = new Aide(join(directory, "state"), {
    cwd: join(directory, "workspace"), timezone: "Asia/Shanghai", connectors,
    defaultHarnessConfig: { id: "default", harness: "pi" },
    // Admit captured destinations without constructing a transport or sending real messages.
    config: ConfigSchema.parse({ channels: { replay: { kind: "lark", label: "Replay only", enabled: true,
      appId: snapshot.identity.accountId, appSecret: "replay-no-delivery" } }, connectors: { lark: { kind: "messages", version: "v1", config: { appId: snapshot.identity.accountId, userId: snapshot.identity.userId,
      me: snapshot.meIds.map(openId => ({ appId: snapshot.identity.accountId, openId })) } } },
      plugins: { personal: { weave: { enabled: options.weave, intervalMs: 1000 } } } }),
    createAdapter: options.createAdapter ?? ((target, ports) => {
      if (!["chief", "route", "weave"].includes(target.harness)) throw new Error(`Replay forbids ${target.harness} execution`);
      if (!options.model) throw new Error("Replay requires an explicit model configuration");
      const factory = target.harness === "chief" ? aide.chiefSession(ports.scope, options.model)
        : target.harness === "route" ? aide.routeSession(ports.scope, options.model) : aide.weaveSession(ports.scope, options.model);
      return new PiAdapter({ harness: target.harness as "chief" | "route" | "weave", log: ports.log, nativeEvent: ports.nativeEvent,
        createSession: async params => {
          const session = restrictSession(await factory(params) as AgentSession);
          session.subscribe(event => {
            if (event.type === "message_end" && event.message.role === "assistant") {
              const u = event.message.usage;
              const totals = usage[target.harness] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
              totals.calls++; totals.input += u.input; totals.output += u.output; totals.cacheRead += u.cacheRead; totals.cacheWrite += u.cacheWrite;
              append({ at: new Date().toISOString(), harness: target.harness, sessionId: session.sessionId, type: "usage", usage: u });
            } else if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
              append({ at: new Date().toISOString(), harness: target.harness, sessionId: session.sessionId, event });
            }
          });
          return session;
        } });
    }),
  }, log);
  const resources = aide.runtime.plugins.resourceClient("personal");
  const logger: PluginContext["logger"] = {
    debug: (message, detail) => log.debug({ detail }, message), info: (message, detail) => log.info({ detail }, message),
    warn: (message, detail) => log.warn({ detail }, message), error: (message, detail) => log.error({ detail }, message),
  };
  const startedAt = new Date().toISOString();
  let batches = 0;
  let state: "completed" | "error" = "error", failure: string | undefined;
  let currentCutoff = snapshot.start;
  const capture = (cutoff: string) => ({ cutoff, at: new Date().toISOString(), topics: aide.topics.list().map(t => {
    const resource = aide.topics.resource(t.id)!;
    return { ...t, uid: resource.metadata.uid, summary: resource.status.summary, recent: resource.status.recent };
  }), outputs: aide.outputs(),
    inputs: aide.topics.inputStore.list().map(input => inputDetail(aide, input.metadata.name)), invocations: aide.invocations() });
  // A settled scheduler may still have unfinished receipts or a future Weave timer. Check all three.
  const drain = async () => {
    const deadline = Date.now() + timeoutMs;
    let stableSince = 0, last = "";
    while (Date.now() < deadline) {
      messages.assertCoverage();
      const inputs = aide.topics.inputStore.list();
      const done = inputs.every(i => i.status.route?.completedAt && Object.values(i.status.assess ?? {}).every(a => a.completedAt));
      const topics = aide.topics.list();
      const roots = topics.filter(t => !t.default && !t.parentRef);
      const weave = await resources.get<Record<string, never>, WeaveStatus>({ ...WEAVE_TYPE, name: "global", namespace: "v1" });
      const quiet = done && !topics.some(t => aide.topics.resource(t.id)?.status.execution)
        && (!options.weave || (weave && !weave.status.execution && !weave.status.plan && (roots.length < 2 || (weave.status.scanned ?? 0) >= roots.length)));
      const fingerprint = JSON.stringify([topics, inputs.map(i => i.status), weave?.status.fingerprint, weave?.status.scanned,
        weave?.status.plan, weave?.status.execution]);
      if (!quiet || fingerprint !== last) stableSince = Date.now();
      if (quiet && Date.now() - stableSince >= settleMs) return;
      last = fingerprint;
      await delay(100);
    }
    throw new Error(`Replay batch did not finish within ${timeoutMs}ms; inspect retained Input receipts and executions`);
  };
  try {
    await aide.start();
    const watch: MessageWatch = { ...MessageWatchSchema.parse({}), ...snapshot.identity, personIds: snapshot.meIds };
    // No configured lark Source: only this runner advances observation time, never a wall-clock polling controller.
    let source = await resources.create<MessageWatch, MessageSourceStatus>(MESSAGE_SOURCE_TYPE, { name: "replay", spec: watch,
      status: { scans: MESSAGE_KINDS.map(kind => ({ kind,
        watermark: new Date(Date.parse(snapshot.start) + watch.overlapMs).toISOString() })) } });
    const triggers = triggerMessages(snapshot);
    const cutoffs: string[] = [];
    for (let n = options.batchSize - 1; n < triggers.length; n += options.batchSize) cutoffs.push(triggers[n]!.createdAt);
    cutoffs.push(snapshot.end);
    for (const cutoff of [...new Set(cutoffs)]) {
      currentCutoff = cutoff;
      messages.advance(cutoff);
      for (let page = 0; ; page++) {
        if (page >= 10_000) throw new Error("Replay Source pagination budget exceeded");
        await observeMessages({ resources, logger }, source, connectors, Date.parse(cutoff));
        messages.assertCoverage();
        source = (await resources.get<MessageWatch, MessageSourceStatus>({ ...MESSAGE_SOURCE_TYPE, ...source.metadata }))!;
        if (source.status.scans?.length === MESSAGE_KINDS.length && source.status.scans.every(s => !s.window && Date.parse(s.watermark ?? "") >= Date.parse(cutoff))
          && !source.status.pending?.some(p => p.delivery || p.follow?.token)) break;
      }
      await drain();
      const batch = capture(cutoff); batches++;
      writeFileSync(join(directory, `batch-${batches}.json`), JSON.stringify(batch, null, 2), { mode: 0o600 });
      log.info({ batch: batches, cutoff, topics: batch.topics.length, outputs: batch.outputs.length }, "Replay batch completed");
    }
    state = "completed";
  } catch (error) { failure = error instanceof Error ? error.message : String(error); log.error({ error: failure }, "Replay stopped"); }
  finally {
    // Capture even failed runs before shutdown changes active executions to interrupted.
    try {
      const result = { version: 1, state, failure, startedAt, finishedAt: new Date().toISOString(),
      revision: options.revision, datasetHash: options.datasetHash, weave: options.weave, batchSize: options.batchSize,
      weaveIntervalMs: 1000, model: options.model?.model, protocolFixture: !!options.createAdapter,
      limitations: ["No external delivery or work execution", "Observation clock only; not a production scheduling, latency or expiry test",
        "Edited message versions excluded", "One explicit model for all roles; no ambient skills", "Output quality requires human review"],
      coverage: snapshot.coverage, source: await resources.get({ ...MESSAGE_SOURCE_TYPE, name: "replay", namespace: "v1" }),
      excludedEdited: snapshot.messages.filter(m => m.updatedAt && Date.parse(m.updatedAt) > Date.parse(m.createdAt)).map(m => m.id),
        usage, batches, ...capture(currentCutoff) };
      try { await aide.close(); }
      catch (error) {
        failure = `Replay cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
        result.state = "error"; result.failure = [result.failure, failure].filter(Boolean).join("; ");
      }
      writeFileSync(join(directory, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
    } finally {
      try { await aide.close(); }
      finally { destination.end(); }
    }
  }
  if (failure) throw new Error(failure);
}
