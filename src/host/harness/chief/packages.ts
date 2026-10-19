import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DefaultPackageManager, loadSkills, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";
import { configPath, type AideConfig } from "../../../config.ts";

function chiefPackages(home: string, config: AideConfig, file: string) {
  const packages = config.harnesses.chief.packages.map((source) => {
    if (source.startsWith("~/")) return join(homedir(), source.slice(2));
    if (isAbsolute(source) || source.startsWith("./") || source.startsWith("../")) return resolve(dirname(file), source);
    return source;
  });
  const agentDir = join(home, "harnesses", "chief");
  const manager = new DefaultPackageManager({
    cwd: dirname(resolve(file)), agentDir,
    settingsManager: SettingsManager.inMemory({ packages: packages.map((source) => ({
      source, extensions: [], prompts: [], themes: [],
    })) }),
  });
  return { manager, packages, agentDir, receipt: join(agentDir, "synced"),
    fingerprint: createHash("sha256").update(JSON.stringify(packages)).digest("hex") };
}

/**
 * @spec Chief loads only declared, installed package skills. Conversation startup never installs packages.
 * @link docs/harness/chief.md
 * @case tests/harness-config.test.ts
 */
export async function loadChiefSkills(home: string, config: AideConfig, log: Logger, file = configPath(home)): Promise<string[]> {
  const installation = chiefPackages(home, config, file);
  const { packages, receipt, fingerprint } = installation;
  if (packages.length && (!existsSync(receipt) || readFileSync(receipt, "utf8") !== fingerprint)) {
    throw new Error("Chief packages are not synced for this configuration; run aide harness sync chief");
  }
  return resolveChiefSkills(installation, log);
}

async function resolveChiefSkills({ manager, packages, agentDir }: ReturnType<typeof chiefPackages>, log: Logger): Promise<string[]> {
  for (const [index, source] of packages.entries()) {
    if (!manager.getInstalledPath(source, "user")) {
      throw new Error(`Chief package ${index + 1} is not installed; run aide harness sync chief`);
    }
  }
  const resources = await manager.resolve(async () => "error");
  const skills = resources.skills.filter((item) => item.enabled && item.metadata.origin === "package");
  for (const [index, source] of packages.entries()) {
    if (!skills.some((item) => item.metadata.source === source)) {
      throw new Error(`Chief package ${index + 1} provides no skills; check its pi.skills manifest`);
    }
  }
  const paths = skills.map((item) => item.path);
  const loaded = loadSkills({ cwd: agentDir, agentDir, skillPaths: paths, includeDefaults: false });
  if (loaded.diagnostics.length) {
    throw new Error(`Invalid Chief package skills: ${loaded.diagnostics.map((item) => `${item.path}: ${item.message}`).join("; ")}`);
  }
  log.info({ harness: "chief", packages: packages.length, skills: skills.length }, "Loaded configured harness skills");
  return paths;
}

/** @spec Package installation and updates are explicit operations; the caller must hold the service lock. */
export async function syncChiefPackages(home: string, config: AideConfig, log: Logger, file = configPath(home)): Promise<void> {
  const installation = chiefPackages(home, config, file);
  const { manager, packages, agentDir, receipt, fingerprint } = installation;
  // Pi shares a Git checkout across refs. Invalidate first so a failed update cannot serve an older declaration.
  rmSync(receipt, { force: true });
  for (const [index, source] of packages.entries()) {
    log.info({ harness: "chief", package: index + 1, total: packages.length }, "Syncing harness package");
    try { await manager.install(source); }
    catch (error) {
      log.error({ harness: "chief", package: index + 1 }, "Harness package sync failed");
      throw error;
    }
  }
  await resolveChiefSkills(installation, log);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(receipt, fingerprint, { mode: 0o600 });
}
