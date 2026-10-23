import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type AgentSession, type ToolDefinition, type ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { PiConfig } from "../../src/host/harness/pi/config.ts";

export interface PiAgentOptions {
  cwd: string;
  config: PiConfig;
  sessionFile?: string;
  sessionId?: string;
  tools?: ToolDefinition[];
  nativeTools?: string[];
  /** Explicit bundled extensions; ambient extension discovery remains disabled. */
  extensionPaths?: string[];
  extensionToolNames?: string[];
  extensionFactories?: ExtensionFactory[];
  /** Host-bound scope prevents resuming a session with different application tools/context. */
  scope?: string;
  systemPrompt?: string;
}

/**
 * @spec Pi SDK owns native session persistence; the Operator retains only the native ID.
 * @why Application scope validates resume independently of the native storage directory.
 * @link docs/harness/pi.md
 */
export async function createPiAgent(options: PiAgentOptions): Promise<AgentSession> {
  const cwd = resolve(options.cwd);
  const { agentDir, model, modelRuntime, skillPaths } = options.config;
  if (options.sessionFile && !existsSync(options.sessionFile)) throw new Error("Pi session file is missing; refusing a silent new session");
  const sessionFile = options.sessionId ? SessionManager.findById(cwd, options.sessionId, `${agentDir}/sessions`) : options.sessionFile;
  if (options.sessionId && !sessionFile) throw new Error(`Pi session not found: ${options.sessionId}`);
  const manager = sessionFile ? SessionManager.open(sessionFile) : undefined;
  const scope = manager?.getEntries().find((entry) => entry.type === "custom" && entry.customType === "aide.agent-scope");
  if (manager && (resolve(manager.getCwd()) !== cwd || scope?.type !== "custom"
    || (scope.data as { scope?: string } | undefined)?.scope !== (options.scope ?? "pi"))) {
    throw new Error("Pi session does not belong to this working directory and scope");
  }
  const settings = SettingsManager.inMemory(structuredClone(options.config.settings));
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
    ...(skillPaths === undefined ? {} : { noSkills: true, additionalSkillPaths: [...skillPaths] }),
    noExtensions: true, additionalExtensionPaths: options.extensionPaths, extensionFactories: options.extensionFactories,
    noPromptTemplates: true, noThemes: true, ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}) });
  await loader.reload();
  if (skillPaths !== undefined && loader.getSkills().diagnostics.length) {
    throw new Error(`Invalid configured Pi skills: ${loader.getSkills().diagnostics.map((item) => `${item.path}: ${item.message}`).join("; ")}`);
  }
  const extensions = loader.getExtensions();
  if (extensions.errors.length) {
    throw new Error(`Pi extension loading failed: ${extensions.errors.map((item) => `${item.path}: ${item.error}`).join("; ")}`);
  }
  const extensionTools = extensions.extensions.flatMap((extension) => [...extension.tools.keys()]).filter(name => !options.extensionToolNames || options.extensionToolNames.includes(name));
  const tools = options.tools ?? [];
  const { session } = await createAgentSession({ cwd, agentDir, sessionManager: manager ?? SessionManager.create(cwd, `${agentDir}/sessions`), modelRuntime,
    settingsManager: settings, resourceLoader: loader, model,
    tools: [...(options.nativeTools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"]), ...tools.map((tool) => tool.name), ...extensionTools], customTools: tools });
  if (!session.model) { session.dispose(); throw new Error("Pi has no configured model; configure Pi auth/models or select a model"); }
  if (!manager) {
    session.sessionManager.appendCustomEntry("aide.agent-scope", { scope: options.scope ?? "pi" });
    // @spec create returns an ID recoverable before inference. Pi persists on its first user message.
    // This initialization instruction is real input; no assistant response or external action is fabricated.
    session.sessionManager.appendMessage({ role: "user", content: [{ type: "text",
      text: "Initialize this Aide agent session. Subsequent inputs provide the work to perform; this initialization requests no external action." }], timestamp: Date.now() });
  }
  session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
  return session;
}
