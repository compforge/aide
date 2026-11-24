import { getCurrentTools, getToolStateChanges, toToolDeclaration } from "@earendil-works/pi-ai";
import { inputDeliveryMarker } from "../../../../agents/pi/input.ts";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { INPUT_ORIGINS, isInternalInput, type InputOrigin } from "../../input/model.ts";
export { INPUT_ORIGINS };
export const BUSINESS_INPUT_ORIGINS = ["channel", "source", "chief"] as const;
export interface ChiefToolDefinition<T extends TSchema = TSchema> extends ToolDefinition<T> { inputOrigins: readonly InputOrigin[] }
export interface ChiefInputTask {
  executionId: string;
  origin: InputOrigin;
  inputs: { id: string; deliveryId?: string; initial?: boolean; summaryOwnerUid?: string; origin: InputOrigin; immediate: boolean; text: string }[];
}
export interface ChiefInputBinding {
  read(): ChiefInputTask;
  inputOrigin(id: string): InputOrigin | undefined;
  noteSummaryOwner?(id: string): Promise<string | undefined>;
  changed(task: ChiefInputTask, tools: string[]): void;
}
const instructions: Record<InputOrigin, string> = {
  channel: "Respond to the business Input. Answer, maintain matter Notes and hand off ongoing Work as needed. Leave tree organization and durable summary maintenance to their own Inputs.",
  source: "Assess the observed business facts within existing authority. Update continuing matter Notes and relevant Work as needed. Observation is not new authorization. Leave tree organization and durable summary maintenance to their own Inputs.",
  chief: "Handle the recorded business decision within its existing authorization. Maintain matter Notes and Work as needed. Leave tree organization and durable summary maintenance to their own Inputs.",
  "aide:followup": "Read the current Note, related Inputs, Work results and replies from Me. Answer the scheduled question when one is present. Otherwise check whether the episode still warrants a response. If closed, retired or superseded by a different plan, finish this check. When the evidence establishes completion, record the outcome and its basis on the same Note and set closedAt. If it establishes that work is ongoing, record the progress, keep the Note open and update or clear the answered check. If an explicit question is still unresolved, ask Me privately with ask_me for the specific missing fact and keep the Note open for the reply. Without a scheduled question, ask only if a missing fact is needed to make a decision or take action. Finish silently when no response is needed. A related Work record alone does not settle the question. Finish this check with assess_input.",
  "aide:summary": "Review only the named owner. Use the owner-specific question in the Input. Read its whole current summary and relevant Notes. What is worth reading by default next time? If you wrote the summary today, would each existing claim still hold at the same scope and certainty? Keep lasting, supported conclusions. Narrow or remove outdated claims. Only closed episodes may supply new lasting conclusions. Preserve disclosure, attribution and explicit corrections. Re-read on version conflict. Finish with assess_input even if nothing warrants a write.",
  "aide:curate": "Read the changed ordinary Notes, related Notes, source Inputs, Work and existing summaries. Correct partial or outdated claims. Assign each retained Note a fitting nature. Use split_note for mixed material. For duplicate Notes, update the existing destination before pruning or retiring the source. Record verified closure of episodes. Finish this Input with assess_input.curatedNotes listing the final noteId and version of every ordinary Note reviewed or written, including merge destinations. Leave unresolved versions pending.",
  "aide:organize": "Organize the Topic tree and its material. Create or move Topics and file Inputs, idle Work and Notes according to responsibility. If a Note spans Topics, use split_note to extract ordinary Notes into the appropriate Topics. Preserve evidence and disclosure. Preserve business assessment receipts. Finish this maintenance Input with assess_input.",
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
 * @spec Input admission may interrupt maintenance at the next model boundary, never halfway through an executing tool.
 * @why A smaller tool list focuses the model on the current task; execution checks also reject stale or unavailable calls.
 * @link docs/personal/chief.md
 */
export function bindChiefInputs(session: AgentSession, tools: readonly ChiefToolDefinition[], binding: ChiefInputBinding): void {
  const declarations = [...tools, ...bundled.filter(tool => session.getActiveToolNames().includes(tool.name))];
  // Different followUp origins are separate tasks, never a union of their tool lists.
  session.agent.followUpMode = "one-at-a-time";
  const prepare = session.agent.prepareNextTurnWithContext;
  const beforeTool = session.agent.beforeToolCall;
  let current: ChiefInputTask | undefined;
  let names: string[] = [];
  let allowed: Set<string> | undefined;
  let delivered = new Set<string>();
  const select = (receivedOrigin?: InputOrigin) => {
    const admitted = binding.read();
    const newExecution = current?.executionId !== admitted.executionId;
    if (newExecution) delivered = new Set(admitted.inputs.filter(input => input.initial !== false).map(input => input.id));
    const urgent = admitted.inputs.find(input => input.immediate && !delivered.has(input.id));
    const origin = urgent?.origin ?? receivedOrigin ?? (newExecution ? admitted.origin : current!.origin);
    // Once steering has selected the task, an unfinished receipt must not override a later delivered followUp.
    for (const input of admitted.inputs.filter(input => input.immediate)) delivered.add(input.id);
    const task = { ...admitted, origin, inputs: admitted.inputs.filter(input => (input.immediate || delivered.has(input.id)) && (isInternalInput({ origin }) ? input.origin === origin : !isInternalInput(input))) };
    const nextNames = toolsForInput(declarations, origin).filter(name => allowed?.has(name));
    if (newExecution || current?.origin !== origin) binding.changed(task, nextNames);
    current = task;
    names = nextNames;
    session.setActiveToolsByName(names);
  };
  // Pi's next-turn hook starts after the first assistant response; initialize before prompt as well.
  const prompt = session.prompt.bind(session);
  session.prompt = async (...args) => {
    // Preserve caller restrictions (for example replay isolation) across every later task switch.
    allowed ??= new Set(session.getActiveToolNames());
    select();
    return prompt(...args);
  };
  session.agent.prepareNextTurnWithContext = async (turn, signal) => {
    select();
    return prepare?.(turn, signal);
  };
  // FollowUp is appended after next-turn preparation. Resolve its delivery at the public request boundary.
  const prepareRequest = session.agent.prepareRequest;
  session.agent.prepareRequest = async (request, signal) => {
    const prepared = await prepareRequest?.(request, signal);
    const context = prepared?.context ?? request.context;
    const admitted = binding.read();
    let receivedOrigin: InputOrigin | undefined;
    for (const input of admitted.inputs) {
      const marker = inputDeliveryMarker(input.deliveryId ?? input.id);
      if (!delivered.has(input.id) && context.messages.some(message => message.role === "user" && (typeof message.content === "string"
        ? message.content.startsWith(`${marker}\n`)
        : message.content.some(part => part.type === "text" && part.text.startsWith(`${marker}\n`))))) {
        delivered.add(input.id);
        receivedOrigin = input.origin;
      }
    }
    select(receivedOrigin);
    const tools = session.agent.state.tools.slice();
    // Pi declares its normal next-turn loadout before queued messages arrive. Project a late delivery's
    // delta with Pi's own transcript helpers so the very next provider request sees the matching tools.
    const changes = getToolStateChanges(getCurrentTools(context.messages), tools.map(toToolDeclaration));
    const messages = context.messages.slice();
    if (changes.toolsAdded.length || changes.toolsRemoved.length) {
      const at = Math.max(0, messages.findLastIndex(message => message.role !== "system"));
      messages.splice(at, 0, { role: "system", content: "", ...changes, timestamp: Date.now() });
    }
    return { ...prepared, context: { ...context, messages, tools } };
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
      content: `Current Input origin: ${current.origin}\n${instructions[current.origin]}\nAdmitted inputs for this task: ${JSON.stringify(current.inputs.slice(0, 10).map(({ id, text }) => ({ inputId: id, text })))}\nAssess each listed inputId once with assess_input. Other origins are background evidence only. An interrupted maintenance Input remains pending; do not acknowledge work you have not performed.`,
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
    if (context.toolCall.name === "ask_me" && !current.inputs.some(i => i.origin === "aide:followup" && i.id === (context.args as { inputId?: string }).inputId))
      return { block: true, reason: "Ask only about the admitted followup" };
    if (context.toolCall.name === "assess_input") {
      const args = context.args as { inputId?: string; workRequests?: unknown[] };
      const origin = current.inputs.find(i => i.id === args.inputId)?.origin ?? (args.inputId ? binding.inputOrigin(args.inputId) : undefined);
      const maintenance = isInternalInput(current);
      if (!origin || (maintenance ? origin !== current.origin || !current.inputs.some(i => i.id === args.inputId) || !!args.workRequests?.length : isInternalInput({ origin })))
        return { block: true, reason: "Assess only Inputs supported by the current task; maintenance cannot hand off business Work" };
    }
    return beforeTool?.(context, signal);
  };
}
