import { resolvePiConfig } from "../src/host/harness/pi/config.ts";
import { resolveChiefConfig } from "../src/host/harness/chief/config.ts";
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import pino from "pino";
import { resolveHarnessConfigs } from "../src/host/harness/config.ts";
import { loadConfig } from "../src/config.ts";
import { loadHarnessSkills, syncHarnessPackages } from "../src/host/harness/packages.ts";
import { withAsyncFileLock } from "../src/host/file-lock.ts";

const log = pino({ level: "silent" });

test("Chief config validates model and package declarations without echoing values", () => {
  const home = mkdtempSync(join(tmpdir(), "aide-harness-config-"));
  const file = join(home, "config.yaml");
  try {
    for (const chief of [{ model: "invalid-secret" }, { model: { provider: "", id: "model" } }, { packages: [""] }, { unknown: true }]) {
      writeFileSync(file, JSON.stringify({ harnesses: { chief } }));
      expect(() => loadConfig(file)).toThrow("Invalid Aide config structure");
    }
    writeFileSync(file, "harnesses:\n  chief:\n    model:\n      provider: fixture\n      id: chosen-model\n    packages: [./capabilities]\n");
    expect(loadConfig(file).harnesses.chief).toEqual({ model: { provider: "fixture", id: "chosen-model" }, packages: ["./capabilities"] });
    writeFileSync(file, JSON.stringify({ harnesses: { chief: { model: "invalid-secret" } } }));
    try { loadConfig(file); throw new Error("Expected invalid config"); }
    catch (error) {
      expect(String(error)).toContain("harnesses.chief.model (invalid_type)");
      expect(String(error)).not.toContain("invalid-secret");
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

for (const harness of ["pi", "chief"] as const)
test(`${harness}: resolves nested package skills relative to config and rejects missing packages without installing`, async () => {
  const home = mkdtempSync(join(tmpdir(), "aide-harness-packages-"));
  const file = join(home, "config.yaml");
  const skill = join(home, "capabilities", "agentsphere", "skills", "as-ops");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: as-ops\ndescription: Inspect an environment through ascli.\n---\nRead evidence.\n");
  writeFileSync(join(home, "capabilities", "package.json"), JSON.stringify({ pi: { skills: ["./agentsphere/skills"] } }));
  try {
    writeFileSync(file, JSON.stringify({ harnesses: { [harness]: { packages: ["./capabilities"] } } }));
    const config = loadConfig(file);
    await syncHarnessPackages(home, harness, config, log, file);
    expect(existsSync(join(home, "harnesses", harness === "pi" ? "chief" : "pi", "synced"))).toBe(false);
    expect(await loadHarnessSkills(home, harness, config, log, file)).toEqual([join(skill, "SKILL.md")]);
    expect(existsSync(join(home, "harnesses", harness, "settings.json"))).toBe(false);
    writeFileSync(file, JSON.stringify({ harnesses: { [harness]: { packages: ["git:example.invalid/team/missing"] } } }));
    await expect(loadHarnessSkills(home, harness, loadConfig(file), log, file)).rejects.toThrow(`run aide harness sync ${harness}`);
    expect(existsSync(join(home, "harnesses", harness, "git"))).toBe(false);
    writeFileSync(join(home, "capabilities", "package.json"), "{}");
    await expect(loadHarnessSkills(home, harness, config, log, file)).rejects.toThrow("provides no skills");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

/** @case An interrupted sync leaves a dead holder; the next invocation recovers without a manual retry. */
for (const harness of ["pi", "chief"] as const)
test(`${harness}: sync CLI recovers a stale service lock, excludes a live holder and accepts empty packages`, async () => {
  const home = mkdtempSync(join(tmpdir(), "aide-harness-cli-"));
  writeFileSync(join(home, "config.yaml"), JSON.stringify({ harnesses: { [harness]: { packages: [] } } }));
  const run = async () => {
    const child = Bun.spawn(["node", "bin/aide.js", "harness", "sync", harness], {
      env: { ...process.env, AIDE_HOME: home, AIDE_CONFIG: join(home, "config.yaml") }, stdout: "pipe", stderr: "pipe",
    });
    return { code: await child.exited, output: await new Response(child.stdout).text() + await new Response(child.stderr).text() };
  };
  try {
    expect((await run()).code).toBe(0);
    const stopped = spawnSync("node", ["-e", "process.exit(0)"]);
    expect(stopped.status).toBe(0);
    writeFileSync(join(home, "host.lock"), `${stopped.pid}:interrupted-sync`);
    const recovered = await run();
    expect(recovered.code).toBe(0);
    expect(existsSync(join(home, "host.lock"))).toBe(false);
    await withAsyncFileLock(join(home, "host"), async () => {
      const result = await run();
      expect(result.code).toBe(1);
      expect(result.output).toContain("stop Aide before syncing");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

for (const harness of ["pi", "chief"] as const)
test(`${harness}: Git packages install explicitly and a changed ref cannot silently load the cached checkout`, async () => {
  const home = mkdtempSync(join(tmpdir(), "aide-harness-git-"));
  const repo = join(home, "origin");
  const skill = join(repo, "skills", "git-skill", "SKILL.md");
  const file = join(home, "config.yaml");
  const gitConfig = join(home, "gitconfig");
  mkdirSync(join(repo, "skills", "git-skill"), { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" } });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  const declare = (ref: string) => writeFileSync(file, JSON.stringify({ harnesses: { [harness]: { packages: [`git:https://fixture.invalid/team/skills@${ref}`] } } }));
  const sync = async () => {
    const child = Bun.spawn(["node", "bin/aide.js", "harness", "sync", harness], {
      env: { ...process.env, AIDE_HOME: home, AIDE_CONFIG: file, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(out + err);
  };
  try {
    // A disposable local Git origin exercises Pi's real clone/checkout without a remote service.
    git("init", "--initial-branch=main");
    git("config", "--file", gitConfig, `url.file://${repo}.insteadOf`, "https://fixture.invalid/team/skills");
    writeFileSync(skill, "---\nname: git-skill\ndescription: First revision.\n---\nUse this skill.\n");
    git("add", "skills");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "first");
    declare(git("rev-parse", "HEAD"));
    await expect(loadHarnessSkills(home, harness, loadConfig(file), log, file)).rejects.toThrow(`run aide harness sync ${harness}`);
    await sync();
    const paths = await loadHarnessSkills(home, harness, loadConfig(file), log, file);
    expect(paths).toHaveLength(1);
    expect(await Bun.file(paths[0]!).text()).toContain("First revision");
    writeFileSync(skill, "---\nname: git-skill\ndescription: Second revision.\n---\nUse this skill.\n");
    git("add", "skills");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "second");
    declare(git("rev-parse", "HEAD"));
    await expect(loadHarnessSkills(home, harness, loadConfig(file), log, file)).rejects.toThrow(`run aide harness sync ${harness}`);
    await sync();
    expect(await Bun.file((await loadHarnessSkills(home, harness, loadConfig(file), log, file))[0]!).text()).toContain("Second revision");
    const successful = loadConfig(file);
    declare("missing-ref");
    await expect(sync()).rejects.toThrow();
    await expect(loadHarnessSkills(home, harness, successful, log, file)).rejects.toThrow(`run aide harness sync ${harness}`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("model definitions and explicit credentials resolve without Pi registration and do not leak on errors", async () => {
  const home = mkdtempSync(join(tmpdir(), "aide-model-config-"));
  try {
    writeFileSync(join(home, "auth.json"), JSON.stringify({ custom: { type: "api_key", key: "old-key" } }));
    const input = { provider: "custom", id: "deployment", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1",
      apiKeyEnv: "TEST_MODEL_KEY", reasoning: false, contextWindow: 8192, maxTokens: 1024 };
    const sources = { cwd: home, agentDir: home, skillPaths: [], environment: { TEST_MODEL_KEY: "new-private-key" } };
    const config = await resolveChiefConfig({ model: input, packages: [] }, sources);
    expect(config.model).toMatchObject({ id: "deployment", reasoning: false, contextWindow: 8192, maxTokens: 1024 });
    expect((await config.modelRuntime.getAuth(config.model))?.auth.apiKey).toBe("new-private-key");
    expect(readFileSync(join(home, "auth.json"), "utf8")).not.toContain("new-private-key");
    expect(existsSync(join(home, "models.json"))).toBe(false);
    await expect(resolveChiefConfig({ model: input, packages: [] }, { ...sources, environment: {} })).rejects.toThrow("model.apiKeyEnv");
    await expect(resolveChiefConfig({ model: { ...input, api: "unsupported" }, packages: [] }, sources)).rejects.toThrow("model.api");
    await expect(resolveChiefConfig({ model: { provider: "unknown", id: "missing" }, packages: [] }, sources)).rejects.toThrow("model.api");
    writeFileSync(join(home, "models.json"), '{"providers": DO-NOT-PRINT');
    try { await resolvePiConfig(sources); throw new Error("expected failure"); }
    catch (error) { expect(String(error)).toContain("Invalid Pi models"); expect(String(error)).not.toContain("DO-NOT-PRINT"); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("invalid Chief model stops Aide before listening or restoring persisted Sessions", () => {
  const home = mkdtempSync(join(tmpdir(), "aide-invalid-startup-"));
  const file = join(home, "config.yaml");
  writeFileSync(file, JSON.stringify({ harnesses: { chief: { model: { provider: "missing-provider", id: "missing-model" } } } }));
  try {
    const result = spawnSync(process.execPath, ["src/main.ts"], { cwd: process.cwd(), encoding: "utf8", timeout: 15000,
      env: { ...process.env, AIDE_HOME: home, AIDE_CONFIG: file, AIDE_CWD: home, PI_CODING_AGENT_DIR: join(home, "pi") } });
    expect(result.status).not.toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain("harnesses.chief");
    expect(result.stderr).toContain("model.api");
    expect(result.stdout).not.toContain("Aide listening");
    expect(existsSync(join(home, "sessions"))).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test("startup resolves independent Pi and Chief models with explicit package skill lists", async () => {
  const home = mkdtempSync(join(tmpdir(), "aide-pi-chief-config-"));
  const file = join(home, "config.yaml");
  const definition = { provider: "fixture", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "TEST_MODEL_KEY" };
  try {
    writeFileSync(file, JSON.stringify({ harnesses: {
      pi: { model: { ...definition, id: "work-model" }, packages: [] },
      chief: { model: { ...definition, id: "chief-model" }, packages: [] },
    } }));
    const config = loadConfig(file);
    const resolved = await resolveHarnessConfigs(config, { home, cwd: home, file, environment: { TEST_MODEL_KEY: "fixture-key" }, log });
    expect(resolved.pi!.model.id).toBe("work-model");
    expect(resolved.chief.model.id).toBe("chief-model");
    expect(resolved.pi!.modelRuntime).not.toBe(resolved.chief.modelRuntime);
    expect(resolved.pi!.skillPaths).toEqual([]);
    expect(resolved.chief.skillPaths).toEqual([]);
    expect(resolved.pi!.settings.packages).toEqual([]);
    expect(resolved.pi!.settings.skills).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test("defaultHarness is an Aide root setting with a Pi default and strict registered execution choices", () => {
  const home = mkdtempSync(join(tmpdir(), "aide-default-selection-"));
  const file = join(home, "config.yaml");
  try {
    writeFileSync(file, "{}"); expect(loadConfig(file).defaultHarness).toBe("pi");
    for (const harness of ["pi", "codex", "claude", "dsh"] as const) {
      writeFileSync(file, JSON.stringify({ defaultHarness: harness }));
      expect(loadConfig(file).defaultHarness).toBe(harness);
    }
    for (const value of [null, "", "chief", "unknown", "cx", 42]) {
      writeFileSync(file, JSON.stringify({ defaultHarness: value }));
      expect(() => loadConfig(file)).toThrow("defaultHarness");
    }
    writeFileSync(file, JSON.stringify({ harnesses: { default: "codex" } }));
    expect(() => loadConfig(file)).toThrow("harnesses");
    for (const invalid of [{ codex: { command: [] } }, { codex: { approvalReviewer: "invalid" } },
      { claude: { executable: "" } }, { dsh: { maxTokens: -1 } }, { dsh: { command: ["dsh"] } }]) {
      writeFileSync(file, JSON.stringify({ harnesses: invalid }));
      expect(() => loadConfig(file)).toThrow("Invalid Aide config structure");
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

for (const harness of ["codex", "claude", "dsh"] as const)
test(`${harness} selection resolves native settings without loading inactive Pi packages or models`, async () => {
  const home = mkdtempSync(join(tmpdir(), "aide-native-selection-"));
  const file = join(home, "config.yaml");
  const native = {
    codex: { command: ["fixture-codex", "app-server"], approvalReviewer: "auto_review", model: "native-model" },
    claude: { executable: "/fixture/claude", model: "native-model" },
    dsh: { model: "native-model", patches: [] },
  };
  try {
    writeFileSync(file, JSON.stringify({ defaultHarness: harness, harnesses: {
      chief: { model: { provider: "fixture", id: "chief-model", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "TEST_MODEL_KEY" } },
      pi: { model: { provider: "missing", id: "inactive" }, packages: ["git:fixture.invalid/unsynced"] },
      [harness]: native[harness],
    } }));
    const config = loadConfig(file);
    const resolved = await resolveHarnessConfigs(config, { home, cwd: home, file,
      environment: { TEST_MODEL_KEY: "fixture-key", AIDE_CLAUDE_BIN: "/ambient/claude" }, log });
    expect(resolved.defaultTarget).toEqual({ id: "default", harness, model: "native-model" });
    expect(resolved.defaultTargetConfig).toMatchObject({ harness, ...native[harness] });
    expect(resolved.chief.model.id).toBe("chief-model");
    expect(resolved.pi).toBeUndefined();
    config.defaultHarness = "pi";
    if (harness === "codex") config.harnesses.codex.command![0] = "changed-command";
    expect(resolved.defaultTarget.harness).toBe(harness);
    expect(resolved.defaultTargetConfig).toMatchObject({ harness, ...native[harness] });
    expect(existsSync(join(home, "harnesses", "pi", "synced"))).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
