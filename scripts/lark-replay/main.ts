import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { SnapshotSchema, collectSnapshot, triggerMessages } from "./snapshot.ts";
import { ReplayTimeoutSchema } from "./config.ts";

const help = `Lark historical replay (private artifacts; no external delivery)
  npm run replay:lark -- collect --config <aide.yaml> --start <ISO> --end <ISO> --out <snapshot.json> [--max-pages 100]
  npm run replay:lark -- replay --dataset <snapshot.json> --run <new-directory> --model <model.json> --weave on|off [--batch-size 20] [--timeout-ms 180000]
  npm run replay:lark -- report --run <directory>

model.json uses Aide's Pi model schema; supply credentials through apiKeyEnv.
Replay uses fresh Pi/Hermes state and no live connectors. Run directories must not already exist.
Batch timeout includes quiet confirmation and must be at least 5000ms.
`;
const required = (value: string | undefined, name: string) => {
  if (!value) throw new Error(`--${name} is required`);
  return value;
};

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: "boolean" }, config: { type: "string" }, start: { type: "string" }, end: { type: "string" },
    out: { type: "string" }, "max-pages": { type: "string" }, dataset: { type: "string" }, run: { type: "string" },
    model: { type: "string" }, weave: { type: "string" }, "batch-size": { type: "string" }, "timeout-ms": { type: "string" },
  } });
  if (values.help || !positionals.length) { process.stdout.write(help); return; }
  const command = positionals[0];
  if (positionals.length !== 1) throw new Error("Expected exactly one command");
  if (command === "collect") {
    const out = resolve(required(values.out, "out"));
    if (existsSync(out)) throw new Error(`Snapshot already exists: ${out}`);
    const start = z.iso.datetime({ offset: true }).parse(required(values.start, "start"));
    const end = z.iso.datetime({ offset: true }).parse(required(values.end, "end"));
    if (Date.parse(start) >= Date.parse(end) || Date.parse(end) > Date.now()) throw new Error("Collection requires a past time range with start before end");
    const maxPages = z.coerce.number().int().min(1).max(1000).parse(values["max-pages"] ?? 100);
    const { loadConfig } = await import("../../src/config.ts");
    const { LarkMessages } = await import("../../connectors/lark/messages.ts");
    const { personalConnectorConfig } = await import("../../plugins/personal/source/connectors.ts");
    const lark = personalConnectorConfig(loadConfig(required(values.config, "config")).connectors).lark;
    if (!lark?.appId || !lark.userId) throw new Error("Collection requires explicit connectors.lark appId/userId");
    const meIds = lark.me.filter(m => m.appId === lark.appId).map(m => m.openId);
    if (!meIds.length) throw new Error("Declare connectors.lark.me for this app; credential owner is not implicitly Me");
    const snapshot = await collectSnapshot(new LarkMessages({ appId: lark.appId, userId: lark.userId, timeoutMs: lark.timeoutMs }), {
      start: new Date(start).toISOString(), end: new Date(end).toISOString(), maxPages, meIds,
      progress: (operation, pages) => process.stderr.write(`${operation}: page ${pages}\n`),
    });
    writeFileSync(out, JSON.stringify(snapshot, null, 2), { flag: "wx", mode: 0o600 });
    const incomplete = snapshot.coverage.filter(c => !c.complete).length;
    process.stdout.write(JSON.stringify({ out, messages: snapshot.messages.length, triggers: triggerMessages(snapshot).length, incomplete }) + "\n");
    if (incomplete) throw new Error("Collection has coverage gaps; inspect the saved snapshot before replay");
    return;
  }
  if (command === "replay") {
    const dataset = readFileSync(resolve(required(values.dataset, "dataset")), "utf8");
    const snapshot = SnapshotSchema.parse(JSON.parse(dataset));
    if (snapshot.coverage.some(c => ["direct", "group", "sent"].includes(c.operation) && !c.complete)) throw new Error("Replay refuses incomplete discovery; recollect before comparing runs");
    if (!triggerMessages(snapshot).length) throw new Error("Snapshot has no replayable trigger messages");
    const weave = z.enum(["on", "off"]).parse(required(values.weave, "weave")) === "on";
    const batchSize = z.coerce.number().int().min(1).max(1000).parse(values["batch-size"] ?? 20);
    const timeoutMs = ReplayTimeoutSchema.parse(values["timeout-ms"]);
    const modelInput = JSON.parse(readFileSync(resolve(required(values.model, "model")), "utf8"));
    const directory = resolve(required(values.run, "run"));
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: new URL("../../", import.meta.url), encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: new URL("../../", import.meta.url), encoding: "utf8" }).trim();
    // Claim ownership before changing process state; an existing directory is never ours to clean up.
    mkdirSync(directory, { mode: 0o700 });
    const previousUmask = process.umask(0o077), previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    let initialized = false;
    // @spec Before the manifest is committed, initialization failure releases only this invocation's directory.
    // @why Hermes needs isolation before runtime imports; restore globals on every exit and retain started-run evidence.
    // @link docs/e2e-lark-replay.md
    // @case tests/lark-replay.test.ts
    try {
      for (const sub of ["pi", "workspace", "state"]) mkdirSync(join(directory, sub), { mode: 0o700 });
      process.env.PI_CODING_AGENT_DIR = join(directory, "pi");
      writeFileSync(join(directory, "pi", "hermes-memory-config.json"), JSON.stringify({
        reviewEnabled: false, correctionDetection: false, flushOnCompact: false, flushOnShutdown: false,
      }));
      const { resolvePiConfig, PiModelConfigSchema } = await import("../../src/host/harness/pi/config.ts");
      const selection = PiModelConfigSchema.parse(modelInput);
      if (!selection.apiKeyEnv) throw new Error("Replay requires model.apiKeyEnv and fresh credentials, not ambient Pi auth");
      if (!process.env[selection.apiKeyEnv]?.trim()) throw new Error(`model.apiKeyEnv references missing environment variable ${selection.apiKeyEnv}`);
      const model = { ...await resolvePiConfig({ cwd: join(directory, "workspace"), agentDir: join(directory, "pi"), model: selection, skillPaths: [] }), loadContextFiles: false };
      writeFileSync(join(directory, "manifest.json"), JSON.stringify({ revision, dirty: !!dirty, selection, weave, batchSize, timeoutMs,
        datasetHash: createHash("sha256").update(dataset).digest("hex"), snapshotRange: [snapshot.start, snapshot.end] }, null, 2));
      initialized = true;
      const { replay } = await import("./run.ts");
      await replay(snapshot, { directory, weave, batchSize, timeoutMs, revision: revision + (dirty ? "-dirty" : ""),
        datasetHash: createHash("sha256").update(dataset).digest("hex"), model });
    } catch (error) {
      if (!initialized) rmSync(directory, { recursive: true, force: true });
      throw error;
    } finally {
      process.umask(previousUmask);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    process.stdout.write(`Replay completed: ${directory}/result.json\n`);
    return;
  }
  if (command === "report") {
    const { report } = await import("./report.ts");
    const directory = resolve(required(values.run, "run"));
    report(directory);
    process.stdout.write(`Report: ${directory}/report.md\n`);
    return;
  }
  throw new Error(`Unknown command: ${command}\n${help}`);
}

if (import.meta.main) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
