#!/usr/bin/env node
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.length === 1 && ["version", "--version", "-v"].includes(args[0])) {
  // Resolve from the installed CLI so the caller's working directory cannot select a different VERSION.
  process.stdout.write(`${readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim()}\n`);
} else {
  process.stderr.write("Usage: aide version\n");
  process.exitCode = args.length ? 1 : 0;
}
