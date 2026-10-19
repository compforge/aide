import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermes resolves its root from the process environment when Pi loads the extension.
// Keep real storage and hooks, but prevent scripted-model suites from calling background models.
export const memoryAgentDir = mkdtempSync(join(tmpdir(), "aide-hermes-test-"));
process.env.PI_CODING_AGENT_DIR = memoryAgentDir;
writeFileSync(join(memoryAgentDir, "hermes-memory-config.json"), JSON.stringify({
  reviewEnabled: false, correctionDetection: false, flushOnCompact: false, flushOnShutdown: false,
}));
process.once("exit", () => rmSync(memoryAgentDir, { recursive: true, force: true }));
