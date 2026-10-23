#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length === 1 && ["version", "--version", "-v"].includes(args[0])) {
  // Resolve from the installed CLI so the caller's working directory cannot select a different VERSION.
  process.stdout.write(`${readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim()}\n`);
} else if (args.length === 3 && args[0] === "harness" && args[1] === "sync" && ["pi", "chief", "task"].includes(args[2])) {
  const localBun = fileURLToPath(new URL("../node_modules/.bin/bun", import.meta.url));
  const result = spawnSync(existsSync(localBun) ? localBun : "bun", [fileURLToPath(new URL("../src/sync-harness.ts", import.meta.url)), args[2]], { stdio: "inherit" });
  if (result.error) process.stderr.write(`Cannot start Bun: ${result.error.message}\n`);
  process.exitCode = result.status ?? 1;
} else {
  process.stderr.write("Usage: aide version | aide harness sync <pi|chief|task>\n");
  process.exitCode = args.length ? 1 : 0;
}
