import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { BUSINESS_INPUT_ORIGINS, INPUT_ORIGINS, isInternalInput, type InputOrigin } from "../../input/model.ts";
export { INPUT_ORIGINS, BUSINESS_INPUT_ORIGINS };
export interface ChiefToolDefinition<T extends TSchema = TSchema> extends ToolDefinition<T> { inputOrigins: readonly InputOrigin[] }
export interface ChiefInputTask {
  executionId: string;
  origin: InputOrigin;
  inputs: { id: string; ongoingUid?: string; summaryOwnerUid?: string; origin: InputOrigin; text: string }[];
}
export interface ChiefInputBinding {
  read(): ChiefInputTask;
  ongoingUid?(id: string): Promise<string | undefined>;
  noteSummaryOwner?(id: string): Promise<string | undefined>;
  onUsageError?(error: unknown): void;
  changed(task: ChiefInputTask, tools: string[]): void;
}
const instructions: Record<InputOrigin, string> = {
  channel: "Decide from the message and its context whether a reply or action is needed. Answer directly when possible. Use Ongoing for an evolving matter that warrants continued follow-up; delegate finite goals to Task and recurring duties to Routine. Leave tree organization and durable summary maintenance to their own Inputs.",
  source: "Assess the observed business facts within existing authority. Update relevant Work with progress. Save evidenced facts or reusable procedures in Notes when worth retaining. Observation is not new authorization. Leave tree organization and durable summary maintenance to their own Inputs.",
  chief: "Handle the recorded business decision within its existing authorization. Update the responsible Work and retain useful knowledge in Notes as needed. Leave tree organization and durable summary maintenance to their own Inputs.",
  "aide:handoff": "Handle the request forwarded by Gate within the original user authorization. Reuse existing Work, track follow-through in Work and retain facts or procedures in Notes when warranted, and reply to the delegated Input when useful.",
  "aide:followup": "Read the specified Ongoing, related Inputs, Work results and replies from Me. If the matter closed, finish silently. An updated check time does not invalidate the open question. When evidence establishes closure, upsert_work with the outcome and basis. The next check defaults to one hour after delivery. Record progress and set a different checkAt when appropriate. Finish a question update before using ask_me. When a consequential fact is missing, ask Me privately with ask_me, then await the reply.",
  "aide:stow": "Session maintenance is handled directly by the runtime.",
  "aide:summary": "Review only the named owner. Use the owner-specific question in the Input. Read its whole current summary and relevant Notes. What is worth reading by default next time? If you wrote the summary today, would each existing claim still hold at the same scope and certainty? Keep lasting, supported conclusions. Narrow or remove outdated claims. Use the evidenced outcome of a concluded matter before generalizing from it. Preserve disclosure, attribution and explicit corrections. Re-read on version conflict.",
  "aide:curate": "Review ordinary Notes and Task, Routine and Ongoing in this Topic using current evidence and existing authority. Identify missing or changed responsibilities, look up existing Work before creating any, and use append_input for material related to existing Work. Confirm the destination before retiring a redundant source Note or winding down superseded Work. Read the changed ordinary Notes, related Notes, source Inputs, Work and existing summaries. Correct partial or outdated claims. Classify retained draft Notes that lack nature. Verify any outstanding responsibility against current Work before acting on it. Use split_note for mixed material. For duplicate Notes, update the existing destination before pruning or retiring the source. Use confirm_curated_notes to confirm the final noteId and version of every ordinary Note reviewed or written, including merge destinations. Use versions returned by fresh reads or writes. If a version changed, reread and correct rejected entries, or omit unresolved Notes to defer them explicitly.",
  "aide:organize": "Organize the Topic tree and its material. Create or move Topics and file Inputs, idle Work and Notes according to responsibility. If a Note spans Topics, use split_note to extract ordinary Notes into the appropriate Topics. Preserve evidence and disclosure.",
};
// Bundled tools have no Personal metadata upstream; their capabilities are declared at this assembly boundary.
const bundled: { name: string; inputOrigins: readonly InputOrigin[] }[] = [
  ...["read", "grep", "find", "ls", "memory_search", "session_search"].map(name => ({ name, inputOrigins: INPUT_ORIGINS })),
  ...["bash", "edit", "write"].map(name => ({ name, inputOrigins: BUSINESS_INPUT_ORIGINS })),
  ...["memory_add", "memory_replace", "memory_remove", "skill_manage"].map(name => ({ name, inputOrigins: ["aide:curate"] as const })),
];
export function toolsForInput(tools: readonly { name: string; inputOrigins: readonly InputOrigin[] }[], origin: InputOrigin): string[] {
  return tools.filter(tool => tool.inputOrigins.includes(origin)).map(tool => tool.name);
}
/**
 * @spec Each provider request exposes only tools declared for its current Input origin; selection never unions task capabilities.
 * @spec One domain execution has one Input origin, including all members of a Deferred Batch.
 * @why A smaller tool list focuses the model on the current task; execution checks also reject stale or unavailable calls.
 * @link docs/personal/chief.md
 */
export function bindChiefInputs(session: AgentSession, tools: readonly ChiefToolDefinition[], binding: ChiefInputBinding): void {
  const declarations = [...tools, ...bundled.filter(tool => session.getActiveToolNames().includes(tool.name))];
  const beforeTool = session.agent.beforeToolCall;
  let current: ChiefInputTask | undefined;
  let names: string[] = [];
  let allowed: Set<string> | undefined;
  let taggedExecution: string | undefined;
  const begin = () => {
    allowed ??= new Set(session.getActiveToolNames());
    current = binding.read();
    names = toolsForInput(declarations, current.origin).filter(name => allowed!.has(name));
    session.setActiveToolsByName(names);
    binding.changed(current, names);
  };
  const prompt = session.prompt.bind(session);
  session.prompt = async (...args) => { begin(); return prompt(...args); };
  const send = session.sendCustomMessage.bind(session);
  session.sendCustomMessage = async (message, options) => {
    if (options?.triggerTurn && !session.isStreaming) begin();
    return send(message, options);
  };
  const prepareRequest = session.agent.prepareRequest;
  session.agent.prepareRequest = (request, signal) => {
    if (current && taggedExecution !== current.executionId) {
      try {
        const origin = isInternalInput(current) ? current.origin : "business";
        session.sessionManager.appendCustomEntry("aide.usage-origin", { origin });
        taggedExecution = current.executionId;
      } catch (error) { binding.onUsageError?.(error); }
    }
    return prepareRequest?.(request, signal);
  };
  // Native request projection rebuilds history; keep task instructions in the replaceable context projection.
  const transform = session.agent.transformContext;
  session.agent.transformContext = async (messages, signal) => {
    const history = transform ? await transform(messages, signal) : messages;
    if (!current) throw new Error("Chief Input task is not selected");
    const at = history.findIndex(message => message.role !== "system");
    const prefix = at < 0 ? history.length : at;
    return [...history.slice(0, prefix), {
      role: "custom" as const, customType: "aide.chief-task", display: false, timestamp: 0,
      content: `Current Input origin: ${current.origin}\n${instructions[current.origin]}\nAdmitted inputs for this task: ${JSON.stringify(current.inputs.slice(0, 10).map(({ id, text }) => ({ inputId: id, text })))}\nOther origins are background evidence only.`,
    }, ...history.slice(prefix)];
  };
  session.agent.beforeToolCall = async (context, signal) => {
    const live = binding.read();
    if (!current || live.executionId !== current.executionId || !names.includes(context.toolCall.name))
      return { block: true, reason: "Tool is unavailable for the current Chief Input task" };
    if (current.origin === "aide:summary" && ["upsert_note", "prune_note", "split_note", "retire_note"].includes(context.toolCall.name)) {
      const args = context.args as { noteId?: string; summaryOf?: { uid?: string } };
      const uid = args.noteId ? await binding.noteSummaryOwner?.(args.noteId) : args.summaryOf?.uid;
      const selected = current.inputs.find(i => i.summaryOwnerUid === uid);
      if (!uid || !selected || !live.inputs.some(i => i.id === selected.id && i.summaryOwnerUid === uid))
        return { block: true, reason: "Only the admitted Summary owner may be edited" };
    }
    if (["upsert_work", "ask_me"].includes(context.toolCall.name) && current.origin === "aide:followup") {
      const args = context.args as { kind?: string; workId?: string };
      const id = (args.kind === "ongoing" || context.toolCall.name === "ask_me") && args.workId;
      const uid = id && await binding.ongoingUid?.(id);
      if (!uid || !current.inputs.some(i => i.ongoingUid === uid && live.inputs.some(l => l.id === i.id)))
        return { block: true, reason: "Use only the Ongoing referenced by the admitted followup" };
    }
    if (context.toolCall.name === "upsert_work" && current.origin === "aide:curate") {
      const args = context.args as { workId?: string; sourceId?: string; inputId?: string };
      if (!args.workId && !args.sourceId && !args.inputId)
        return { block: true, reason: "Identify the source Note, Work or business Input for the new responsibility" };
    }
    return beforeTool?.(context, signal);
  };
}
