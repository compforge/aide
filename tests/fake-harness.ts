import { randomUUID } from "node:crypto";
import type { HarnessAdapter, HarnessEventSink, PromptInput } from "../src/host/harness/adapter.ts";
import type { Work } from "../plugins/personal/model.ts";
import type { Outcome } from "../plugins/personal/prompts.ts";

export interface Agent {
  chief?(prompt: string): Promise<string>;
  execute(work: Work): Promise<Outcome | string>;
}

/** Exercise the real Runner/verb/Turn path; replace only the external Harness protocol. */
export function fakeOptions(agent: Agent, cwd: string, requests: string[] = []) {
  return { cwd, timezone: "UTC", createAdapter: (target: { harness: string } = { harness: "codex" }): HarnessAdapter => {
    let sink: HarnessEventSink;
    let active: PromptInput | undefined;
    const finish = (turnId: string, stopReason: string) => {
      if (active?.turnId !== turnId) return;
      active = undefined;
      sink({ kind: "state_update", turnId, payload: { state: "idle", stopReason } });
    };
    return {
      harness: target.harness, capabilities: { prompt: {}, sync: { supported: true } },
      async open(_options, events) { sink = events; return { harness: target.harness, handleId: randomUUID() }; },
      async sendTurn(_ref, input) {
        active = input;
        const prompt = input.blocks.map((block) => block.type === "text" ? block.text : "").join("\n");
        requests.push(prompt);
        const data = (label: string) => JSON.parse(prompt.split(label)[1]!.split("\n")[0]!);
        void Promise.resolve().then<Outcome | string>(() => target.harness === "pi"
          ? agent.chief?.(prompt) ?? "你好"
          : agent.execute(data("Work: "))).then((result) => {
          if (active?.turnId !== input.turnId) return;
          sink({ kind: "agent_message", turnId: input.turnId,
            payload: { messageId: randomUUID(), phase: "commentary", content: [{ type: "text", text: "我先检查当前工作。" }] } });
          sink({ kind: "agent_message", turnId: input.turnId,
            payload: { messageId: randomUUID(), phase: "final", content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] } });
          finish(input.turnId, "end_turn");
        }, () => finish(input.turnId, "error"));
        return { accepted: true, effective: "new_turn" };
      },
      async cancel() { if (active) finish(active.turnId, "cancelled"); },
      async close() { if (active) finish(active.turnId, "cancelled"); },
    };
  } };
}
