import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateCodexStructured } from "../src/harness/codex.ts";

test("Codex subprocess receives stdin/schema/cwd and returns parsed JSON", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aide-harness-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "fake-codex.mjs");
  writeFileSync(script, `
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
const schema = args[args.indexOf('--output-schema') + 1];
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
writeFileSync(output, JSON.stringify({ prompt, cwd: process.cwd(), args,
  schema: JSON.parse(readFileSync(schema)), output }));
`);
  const result = await generateCodexStructured({
    prompt: "看下今天的待办", cwd: dir, sandbox: "read-only", model: "test-model",
    jsonSchema: { type: "object" },
  }, { command: [process.execPath, script] }) as {
    prompt: string; cwd: string; args: string[]; output: string; schema: unknown;
  };
  assert.equal(result.prompt, "看下今天的待办");
  assert.equal(result.cwd, realpathSync(dir));
  assert.ok(result.args.includes("exec"));
  assert.ok(result.args.includes("--ephemeral"));
  assert.equal(result.args[result.args.indexOf("-s") + 1], "read-only");
  assert.deepEqual(result.schema, { type: "object" });
  assert.equal(existsSync(result.output), false);
});

test("Codex timeout and shutdown stop execution without hanging", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aide-timeout-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "hang.mjs");
  writeFileSync(script, "setInterval(() => {}, 1000);");
  const request = { prompt: "test", cwd: dir, jsonSchema: { type: "object" }, timeoutMs: 100 };
  const options = { command: [process.execPath, script] };
  await assert.rejects(generateCodexStructured(request, options), /timed out/);
  const controller = new AbortController();
  const execution = generateCodexStructured({ ...request, timeoutMs: 5_000, signal: controller.signal }, options);
  controller.abort();
  await assert.rejects(execution, /failed/);
});
