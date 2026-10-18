import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface PiAgentOptions {
  cwd: string;
  /** Pi owns credentials/model configuration here; defaults to ~/.pi/agent. */
  agentDir?: string;
  /** Aide-owned native session directory, separate from Pi's interactive sessions. */
  sessionDir: string;
  sessionFile?: string;
  model?: { provider: string; id: string };
  tools?: ToolDefinition[];
  /** Host-bound scope prevents resuming a session with different application tools/context. */
  scope?: string;
  systemPrompt?: string;
}

/**
 * @spec The generic Pi agent owns SDK sessions and native tools; application policy and tools are injected by its caller.
 * @link docs/harness/pi.md
 */
export async function createPiAgent(options: PiAgentOptions): Promise<AgentSession> {
  const cwd = resolve(options.cwd);
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  if (options.sessionFile && !existsSync(options.sessionFile)) throw new Error("Pi session file is missing; refusing a silent new session");
  const manager = options.sessionFile ? SessionManager.open(options.sessionFile, options.sessionDir)
    : SessionManager.create(cwd, options.sessionDir);
  const scope = manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "aide.agent-scope");
  if (options.sessionFile && (resolve(manager.getCwd()) !== cwd || scope?.type !== "custom"
    || (scope.data as { scope?: string } | undefined)?.scope !== (options.scope ?? "pi"))) {
    throw new Error("Pi session does not belong to this working directory and scope");
  }
  if (!scope) manager.appendCustomEntry("aide.agent-scope", { scope: options.scope ?? "pi" });
  const settings = SettingsManager.create(cwd, agentDir);
  settings.applyOverrides({ retry: { enabled: false }, httpIdleTimeoutMs: 60_000 });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
    noExtensions: true, noPromptTemplates: true, noThemes: true, ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}) });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const model = options.model ? modelRuntime.getModel(options.model.provider, options.model.id) : undefined;
  if (options.model && !model) throw new Error(`Unknown Pi model: ${options.model.provider}/${options.model.id}`);
  const tools = options.tools ?? [];
  const { session } = await createAgentSession({ cwd, agentDir, sessionManager: manager, modelRuntime,
    settingsManager: settings, resourceLoader: loader, ...(model ? { model } : {}),
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls", ...tools.map((tool) => tool.name)], customTools: tools });
  if (!session.model) { session.dispose(); throw new Error("Pi has no configured model; configure Pi auth/models or select a model"); }
  return session;
}
