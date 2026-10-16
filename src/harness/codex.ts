import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StructuredRequest } from "./types.ts";
import { signalProcessTree } from "./process.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const STDERR_MAX_CHARS = 16_384;

export interface CodexTextgenOptions {
  /** Codex executable and optional wrapper/global arguments. */
  command?: string[];
  env?: Readonly<Record<string, string>>;
}

/** exec argv 构造（纯函数，测试锚点）：schema/output 文件路径由调用方分配。 */
export function codexExecArgs(request: StructuredRequest, schemaPath: string, outputPath: string): string[] {
  return [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    ...(request.sandbox ? ["-s", request.sandbox] : []),
    ...(request.model ? ["--model", request.model] : []),
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "-", // prompt 走 stdin
  ];
}

export async function generateCodexStructured(
  request: StructuredRequest,
  options: CodexTextgenOptions = {},
): Promise<unknown> {
  // mkdtempSync 已保证目录唯一，文件名无需再带随机部分。
  const dir = mkdtempSync(join(tmpdir(), "aide-codex-"));
  const schemaPath = join(dir, "schema.json");
  const outputPath = join(dir, "output.json");
  try {
    writeFileSync(schemaPath, JSON.stringify(request.jsonSchema));
    const argv = codexExecArgs(request, schemaPath, outputPath);
    const [binary, ...prefix] = options.command ?? ["codex"];
    if (!binary) throw new Error("Codex command must not be empty");
    await execCodex(binary, [...prefix, ...argv], request, options.env);
    return JSON.parse(readFileSync(outputPath, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function execCodex(
  binary: string,
  argv: string[],
  request: StructuredRequest,
  env?: Readonly<Record<string, string>>,
): Promise<void> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  request.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, argv, {
      cwd: request.cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "ignore", "pipe"],
      detached: process.platform !== "win32",
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-STDERR_MAX_CHARS);
    });
    // 子进程可能在 stdin 写完前因 auth/config 退出；终态统一由 close 回调报告。
    child.stdin.on("error", () => {});
    const abort = () => signalProcessTree(child, "SIGKILL");
    request.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      signalProcessTree(child, "SIGKILL");
      reject(new Error(`codex textgen timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      if (code === 0) resolve();
      else reject(new Error(`codex textgen failed (exit ${code}): ${stderr.trim()}`));
    });
    child.stdin.end(request.prompt);
  });
}
