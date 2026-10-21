import { ConfigSchema } from "../src/config.ts";
import { ResourceStorage, type StoredResource } from "../src/host/resource/storage.ts";
import type { ConversationStatus } from "../plugins/personal/conversation/model.ts";
import { randomUUID } from "node:crypto";
import type { HarnessAdapter, HarnessEventSink, PromptInput } from "../src/host/harness/adapter.ts";
import type { Work } from "../plugins/personal/model.ts";
import type { Outcome } from "../plugins/personal/prompts.ts";

export interface Agent {
  notify?: boolean;
  chief?(prompt: string): Promise<string>;
  execute(work: Work): Promise<Outcome | string>;
}

/** Exercise the real Runner/verb/Turn path; replace only the external Harness protocol. */
export function fakeOptions(agent: Agent, cwd: string, requests: string[] = [], home = cwd) {
  return { config: ConfigSchema.parse({ plugins: { personal: { conversation: { batchSize: 1 } } } }), cwd, timezone: "UTC", defaultTarget: { id: "default", harness: "pi" as const }, createAdapter: (target: { harness: string } = { harness: "pi" }): HarnessAdapter => {
    let sink: HarnessEventSink;
    let active: PromptInput | undefined;
    let conversationId: string | undefined;
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
        const activation = prompt.split("Activation: ")[1]?.split("\n")[0];
        if (activation) conversationId = JSON.parse(activation).conversationId;
        const data = (label: string) => JSON.parse(prompt.split(label)[1]!.split("\n")[0]!);
        void Promise.resolve().then<Outcome | string>(() => target.harness === "chief"
          ? agent.chief?.(prompt) ?? "你好"
          : agent.execute(data("Work: "))).then((result) => {
          if (active?.turnId !== input.turnId) return;
          // Simulate an explicit say tool call, not automatic delivery of finalText. Tests may disable it.
          if (target.harness === "chief" && agent.notify !== false && conversationId && typeof result === "string" && result) {
            const storage = ResourceStorage.open(home);
            const row = storage.db.prepare("SELECT key,scope,data FROM resources WHERE kind='aide.dev/Conversation' AND json_extract(data,'$.object.spec.id')=?").get(conversationId);
            if (row) {
              const stored = JSON.parse(row.data as string) as StoredResource;
              const status = stored.object.status as ConversationStatus;
              const run = Object.values(status.processing).find((s) => s.phase === "running" && !s.roundId);
              if (run && !run.question && !run.quietReason && !run.compacting) {
                run.notifications = [...run.notifications ?? [], { id: randomUUID(), text: result }];
                stored.object = { ...stored.object, metadata: { ...stored.object.metadata, resourceVersion: String(Number(stored.object.metadata.resourceVersion) + 1) } };
                storage.write(row.key as string, row.scope as string, stored);
              }
            }
          }
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
