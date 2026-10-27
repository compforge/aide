import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, configPath } from "../src/config.ts";
import { Connectors } from "../connectors/index.ts";
import { resolveEnvironmentConfig } from "../connectors/environments/config.ts";

const roots: string[] = [];
function path() {
  const root = mkdtempSync(join(tmpdir(), "aide-environments-"));
  roots.push(root);
  return join(root, "config.yaml");
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("config owns declarations and each host gets one snapshot, without opening kubeconfig or SSH", async () => {
  const file = path();
  writeFileSync(file, `connectors:
  environments:
    dev:
      kind: kubernetes
      description: Development
      aliases: [开发]
      kubeconfig: /does-not-exist/dev.yaml
      context: dev
      namespace: app
      host: {name: devbox, transport: ssh, address: unreachable.invalid}
    workstation:
      kind: host
    other:
      description: Generic target
plugins:
  personal:
    sources: {}
`);
  const connectors = Connectors.fromConfig(loadConfig(file).connectors);
  const environment = await connectors.environments.get("开发");
  expect(environment).toMatchObject({ name: "dev", context: "dev", namespace: "app", host: { transport: "ssh" } });
  expect(await connectors.environments.list()).toEqual([
    { name: "dev", kind: "kubernetes", description: "Development", aliases: ["开发"] },
    { name: "workstation", kind: "host" }, { name: "other", description: "Generic target" },
  ]);
  expect(JSON.stringify(await connectors.describe())).not.toContain("kubeconfig");
  // @case Unknown names never inherit the user's default kubeconfig.
  await expect(connectors.environments.get("missing")).rejects.toThrow("Unknown environment: missing");
  writeFileSync(file, "connectors: {environments: {new: {kind: host}}}");
  expect((await connectors.environments.get("dev")).name).toBe("dev");
  expect(await Connectors.fromConfig(loadConfig(file).connectors).environments.list()).toEqual([{ name: "new", kind: "host" }]);
  const mutated = environment as unknown as { host: { address: string }; aliases: string[] };
  mutated.host.address = "changed"; mutated.aliases.push("changed");
  expect((await connectors.environments.get("dev")).host).toMatchObject({ address: "unreachable.invalid" });
  expect((await connectors.environments.list())[0]!.aliases).toEqual(["开发"]);
});

test("invalid or ambiguous declarations fail at startup without echoing credential values", () => {
  for (const config of [
    { dev: { aliases: ["prod"] }, prod: {} },
    { dev: { aliases: ["dev"] } },
    { dev: { aliases: ["shared"] }, prod: { aliases: ["shared"] } },
  ]) expect(() => resolveEnvironmentConfig(config)).toThrow("Duplicate environment name or alias");
  for (const config of [
    { dev: { kind: "kubernetes" } },
    { dev: { host: { name: "vm", transport: "ssh" } } },
    { dev: { host: { name: "vm", address: "unqualified" } } },
    { dev: { kind: "host", namespace: "misplaced" } },
    { dev: { kind: "unsupported" } },
    { dev: { token: "DO-NOT-PRINT" } },
    { dev: { provider: "static" } },
  ]) expect(() => resolveEnvironmentConfig(config)).toThrow("Invalid environment declaration: dev");
  expect(() => resolveEnvironmentConfig({ " ": {} })).toThrow("Environment names");
});

test("config defaults, explicit path, YAML/JSON, and structural errors are deterministic", () => {
  const file = path();
  const previous = process.env.AIDE_CONFIG;
  const previousHome = process.env.AIDE_HOME;
  try {
    delete process.env.AIDE_CONFIG;
    process.env.AIDE_HOME = join(file, "..");
    expect(configPath("/home/aide")).toBe("/home/aide/config.yaml");
    expect(loadConfig()).toEqual({ connectors: { environments: {}, requirements: {}, forges: {}, packages: [], connections: {} }, plugins: {}, defaultHarness: "pi", defaultChannel: "web", channels: {}, harnesses: { codex: {}, claude: {}, dsh: {}, pi: { packages: [] }, chief: { packages: [] }, task: { packages: [] }, routine: { packages: [] }, route: {}, weave: {} } });
    expect(() => loadConfig(file)).toThrow("Aide config not found");
    process.env.AIDE_CONFIG = file;
    expect(configPath("/ignored")).toBe(file);
    expect(() => loadConfig()).toThrow("Aide config not found");
    for (const text of ["connectors: [", "connectors: {}\nconnectors: {}", "connectors: []", "unknown: value"]) {
      writeFileSync(file, text);
      expect(() => loadConfig(file)).toThrow(/Invalid Aide/);
    }
    writeFileSync(file, JSON.stringify({ connectors: { environments: { dev: { kind: "host" } } } }));
    process.env.AIDE_CONFIG = `${file}.missing`;
    expect(loadConfig(file).connectors.environments).toEqual({ dev: { kind: "host" } });
  } finally {
    if (previous === undefined) delete process.env.AIDE_CONFIG; else process.env.AIDE_CONFIG = previous;
    if (previousHome === undefined) delete process.env.AIDE_HOME; else process.env.AIDE_HOME = previousHome;
  }
});

