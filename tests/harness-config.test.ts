import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import pino from "pino";
import { loadConfig } from "../src/config.ts";
import { loadChiefSkills, syncChiefPackages } from "../src/harness-config.ts";
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

test("Chief resolves nested package skills relative to config and rejects missing packages without installing", async () => {
  const home = mkdtempSync(join(tmpdir(), "aide-harness-packages-"));
  const file = join(home, "config.yaml");
  const skill = join(home, "capabilities", "agentsphere", "skills", "as-ops");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: as-ops\ndescription: Inspect an environment through ascli.\n---\nRead evidence.\n");
  writeFileSync(join(home, "capabilities", "package.json"), JSON.stringify({ pi: { skills: ["./agentsphere/skills"] } }));
  try {
    writeFileSync(file, JSON.stringify({ harnesses: { chief: { packages: ["./capabilities"] } } }));
    const config = loadConfig(file);
    await syncChiefPackages(home, config, log, file);
    expect(await loadChiefSkills(home, config, log, file)).toEqual([join(skill, "SKILL.md")]);
    expect(existsSync(join(home, "harnesses", "chief", "settings.json"))).toBe(false);
    writeFileSync(file, JSON.stringify({ harnesses: { chief: { packages: ["git:example.invalid/team/missing"] } } }));
    await expect(loadChiefSkills(home, loadConfig(file), log, file)).rejects.toThrow("run aide harness sync chief");
    expect(existsSync(join(home, "harnesses", "chief", "git"))).toBe(false);
    writeFileSync(join(home, "capabilities", "package.json"), "{}");
    await expect(loadChiefSkills(home, config, log, file)).rejects.toThrow("provides no skills");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("sync CLI shares the running service lock and accepts an empty package list", async () => {
  const home = mkdtempSync(join(tmpdir(), "aide-harness-cli-"));
  writeFileSync(join(home, "config.yaml"), "harnesses:\n  chief:\n    packages: []\n");
  const run = async () => {
    const child = Bun.spawn(["node", "bin/aide.js", "harness", "sync", "chief"], {
      env: { ...process.env, AIDE_HOME: home, AIDE_CONFIG: join(home, "config.yaml") }, stdout: "pipe", stderr: "pipe",
    });
    return { code: await child.exited, output: await new Response(child.stdout).text() + await new Response(child.stderr).text() };
  };
  try {
    expect((await run()).code).toBe(0);
    await withAsyncFileLock(join(home, "host"), async () => {
      const result = await run();
      expect(result.code).toBe(1);
      expect(result.output).toContain("stop Aide before syncing");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("Git packages install explicitly and a changed ref cannot silently load the cached checkout", async () => {
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
  const declare = (ref: string) => writeFileSync(file, JSON.stringify({ harnesses: { chief: { packages: [`git:https://fixture.invalid/team/skills@${ref}`] } } }));
  const sync = async () => {
    const child = Bun.spawn(["node", "bin/aide.js", "harness", "sync", "chief"], {
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
    await expect(loadChiefSkills(home, loadConfig(file), log, file)).rejects.toThrow("run aide harness sync chief");
    await sync();
    const paths = await loadChiefSkills(home, loadConfig(file), log, file);
    expect(paths).toHaveLength(1);
    expect(await Bun.file(paths[0]!).text()).toContain("First revision");
    writeFileSync(skill, "---\nname: git-skill\ndescription: Second revision.\n---\nUse this skill.\n");
    git("add", "skills");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "second");
    declare(git("rev-parse", "HEAD"));
    await expect(loadChiefSkills(home, loadConfig(file), log, file)).rejects.toThrow("run aide harness sync chief");
    await sync();
    expect(await Bun.file((await loadChiefSkills(home, loadConfig(file), log, file))[0]!).text()).toContain("Second revision");
    const successful = loadConfig(file);
    declare("missing-ref");
    await expect(sync()).rejects.toThrow();
    await expect(loadChiefSkills(home, successful, log, file)).rejects.toThrow("run aide harness sync chief");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
