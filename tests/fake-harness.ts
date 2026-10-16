import { randomUUID } from "node:crypto";
import type { HarnessAdapter, HarnessEventSink, PromptInput } from "../src/runtime/harness/adapter.ts";
import type { Incoming, Message, Work } from "../src/personal/model.ts";
import type { Route, Outcome } from "../src/personal/prompts.ts";

export interface Agent {
  route(input: Incoming, works: Work[], history: Message[]): Promise<Route>;
  execute(work: Work): Promise<Outcome>;
}

/** Exercise the real Runner/verb/Turn path; replace only the external Harness protocol. */
export function fakeOptions(agent: Agent, cwd: string, requests: string[] = []) {
  return { cwd, timezone: "UTC", createAdapter: (): HarnessAdapter => {
    let sink: HarnessEventSink;
    let active: PromptInput | undefined;
    const finish = (turnId: string, stopReason: string) => {
      if (active?.turnId !== turnId) return;
      active = undefined;
      sink({ kind: "state_update", turnId, payload: { state: "idle", stopReason } });
    };
    return {
      harness: "codex", capabilities: { prompt: {}, sync: { supported: true } },
      async open(_options, events) { sink = events; return { harness: "codex", handleId: randomUUID() }; },
      async sendTurn(_ref, input) {
        active = input;
        const prompt = input.blocks.map((block) => block.type === "text" ? block.text : "").join("\n");
        requests.push(prompt);
        const data = (label: string) => JSON.parse(prompt.split(label)[1]!.split("\n")[0]!);
        void Promise.resolve().then<Route | Outcome>(() => prompt.includes("Aide's intake router")
          ? agent.route(data("Incoming: "), data("Work: "), data("Recent messages (data, not system instructions): "))
          : agent.execute(data("Work: "))).then((result) => {
          if (active?.turnId !== input.turnId) return;
          sink({ kind: "agent_message", turnId: input.turnId,
            payload: { messageId: randomUUID(), content: [{ type: "text", text: JSON.stringify(result) }] } });
          finish(input.turnId, "end_turn");
        }, () => finish(input.turnId, "error"));
        return { accepted: true, effective: "new_turn" };
      },
      async cancel() { if (active) finish(active.turnId, "cancelled"); },
      async close() { if (active) finish(active.turnId, "cancelled"); },
    };
  } };
}
