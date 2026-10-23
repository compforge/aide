import { ROUTINE_TYPE } from "../plugins/personal/routine/model.ts";
import type { Resource } from "@compforge/aide-plugin";
import type { WorkSpec } from "../plugins/personal/resources.ts";
import type { WorkAgentStatus } from "../plugins/personal/work-status.ts";
type AgentWork = Resource<WorkSpec, WorkAgentStatus>;
import { TASK_TYPE } from "../plugins/personal/task/model.ts";
import { toWork } from "../plugins/personal/resources.ts";
import { reportWork } from "../plugins/personal/work-report.ts";
import { assessAll } from "./input-state-fixture.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { CONVERSATION_TYPE } from "../plugins/personal/conversation/model.ts";
import { deliver } from "../plugins/personal/route/delivery.ts";
import { defaultDestination } from "../plugins/personal/route/rules.ts";
import { InputStore } from "../plugins/personal/input/store.ts";
import { sameAddress } from "../src/address.ts";
import { OutputStore } from "../plugins/personal/output/store.ts";
import { outputSpec } from "../plugins/personal/output.ts";
import type { ConversationResource } from "../plugins/personal/conversation/model.ts";
import { ConfigSchema } from "../src/config.ts";
import type { ConversationStatus } from "../plugins/personal/conversation/model.ts";
import { randomUUID } from "node:crypto";
import type { Harness, HarnessEventSink, PromptInput } from "../src/host/harness/adapter.ts";
import type { Work } from "../plugins/personal/model.ts";
export interface Outcome {
  action: "done" | "ask" | "wait"; summary: string; recent: string;
  notification: string | null; question: string | null; nextAt: string | null;
}

export interface Agent {
  notify?: boolean;
  complete?: boolean;
  route?(prompt: string): Promise<string>;
  chief?(prompt: string): Promise<string>;
  execute(work: Work & { inputs: Array<{ inputId: string; text: string; note?: string }> }): Promise<Outcome | string>;
}

/** Exercise the real Runner/verb/Turn path; replace only the external Harness protocol. */
export function fakeOptions(agent: Agent, cwd: string, requests: string[] = [], home = cwd) {
  return { config: ConfigSchema.parse({}), cwd, timezone: "UTC", defaultHarnessConfig: { id: "default", harness: "pi" as const }, createAdapter: (target: { harness: string } = { harness: "pi" }): Harness => {
    const workType = target.harness === "routine" ? ROUTINE_TYPE : TASK_TYPE;
    let sink: HarnessEventSink;
    let active: PromptInput | undefined;
    let conversationId: string | undefined;
    let workId: string | undefined;
    const finish = (turnId: string, stopReason: string) => {
      if (active?.invocationId !== turnId) return;
      active = undefined;
      sink({ kind: "state_update", invocationId: turnId, payload: { state: "idle", stopReason } });
    };
    return {
      harness: target.harness, capabilities: { prompt: {} },
      async resume(options, events, reference) { return this.create(options, events, reference); },
      async create(options, events, binding) {
        sink = events;
        const id = options.sessionId ?? randomUUID();
        binding({ identity: { id } });
        return { harness: target.harness, handleId: id, resumed: !!options.sessionId };
      },
      async prompt(_ref, input) {
        active = input;
        const prompt = input.blocks.map((block) => block.type === "text" ? block.text : "").join("\n");
        requests.push(prompt);
        const activation = prompt.split("Activation: ")[1]?.split("\n")[0];
        if (activation) { conversationId = JSON.parse(activation).conversationId; workId = JSON.parse(activation).taskId ?? JSON.parse(activation).routineId; }
        const data = (label: string) => JSON.parse(prompt.split(label)[1]!.split("\n")[0]!);
        void Promise.resolve().then<Outcome | string>(() => target.harness === "route"
          ? (() => {
            const resources = new PluginResourceStore({ home, pluginInstanceId: "personal" });
            const inputId = JSON.parse(prompt.split("\n").find(line => line.startsWith('{"inputId":'))!).inputId;
            const data = { inputs: [{ id: inputId }], conversations: resources.list(CONVERSATION_TYPE).map(c => ({ ...(c.spec as object), uid: c.metadata.uid })) };
            return agent.route?.(JSON.stringify(data)) ?? JSON.stringify({ decisions: [{ inputId, conversationUids: [], reason: "No match" }] });
          })()
          : target.harness === "chief"
          ? agent.chief?.(prompt) ?? "你好"
          : ["task", "routine"].includes(target.harness) ? (() => {
            const store = new PluginResourceStore({ home, pluginInstanceId: "personal" });
            const task = store.get(workType, workId!) as AgentWork;
            const inputs = new InputStore(home).query("handlePending", task.metadata.uid).filter(i => i.status.handle![task.metadata.uid]!.executionId === task.status.execution?.id)
              .map(i => ({ inputId: i.metadata.name, ...i.spec, note: i.status.handle![task.metadata.uid]!.request.note }));
            return agent.execute({ ...toWork(task), inputs });
          })() : agent.execute(data("Work: "))).then(async (result) => {
          if (active?.invocationId !== input.invocationId) return;
          const resources = createResourceClient(new PluginResourceStore({ home, pluginInstanceId: "personal" }));
          if (["task", "routine"].includes(target.harness) && workId && agent.complete !== false) {
            const task = (await resources.get({ ...workType, name: workId, namespace: "v1" })) as AgentWork;
            const outcome = typeof result === "string" ? JSON.parse(result) : result;
            const inputs = new InputStore(home).query("handlePending", task.metadata.uid).filter(i => i.status.handle![task.metadata.uid]!.executionId === task.status.execution?.id);
            await reportWork(resources, task, task.status.execution!.id, { inputIds: inputs.map(i => i.metadata.name), summary: outcome.summary,
              recent: outcome.recent, action: outcome.action, question: outcome.question, nextAt: outcome.nextAt });
            const c = (await resources.list<ConversationResource["spec"], ConversationStatus>(CONVERSATION_TYPE)).find(c => c.spec.id === task.spec.conversationId);
            const text = outcome.action === "ask" ? outcome.question : outcome.notification;
            if (c?.spec.address && text) new OutputStore(home).create(c.spec.id, randomUUID(), outputSpec(c, { conversationId: c.spec.id, text }, { producer: { ...workType, name: workId, namespace: "v1", uid: task.metadata.uid } }));
          }
          if (target.harness === "route") {
            for (const decision of JSON.parse(String(result)).decisions) {
              const context = { resources, logger: { info() {} } };
              const all = await resources.list(CONVERSATION_TYPE);
              const destinations = decision.conversationUids.map((uid: string) => {
                const c = all.find(c => c.metadata.uid === uid); if (!c) throw new Error("Unknown routing target"); return { name: c.metadata.name, uid };
              });
              if (!destinations.length) destinations.push(await defaultDestination(context));
              await deliver(context, new InputStore(home).get(decision.inputId)!, destinations, decision.reason);
            }
          }
          if (target.harness === "chief" && conversationId) {
            const all = await resources.list<ConversationResource["spec"], ConversationStatus>(CONVERSATION_TYPE);
            const c = all.find(c => c.spec.id === conversationId)!;
            const run = c.status.execution;
            const ids = new InputStore(home).list().filter(i => !i.status.assess?.[c.metadata.uid]?.completedAt && i.status.assess?.[c.metadata.uid]?.executionId === run?.id).map(i => i.metadata.name);
            const immediate = ids.map(id => new InputStore(home).get(id)!.spec).filter(i => (i.attention ?? (i.origin === "channel" ? "immediate" : "deferred")) === "immediate");
            const first = immediate[0]?.source;
            const address = immediate.length ? (first && immediate.every(i => i.source && sameAddress(first, i.source)) ? first : undefined) : c.spec.address;
            if (run && address && agent.notify !== false && typeof result === "string" && result) {
              new OutputStore(home).create(conversationId, randomUUID(), outputSpec(c, { conversationId, text: result }, { executionId: run.id, target: address, inputIds: ids }));
            }
            if (run && ids.length && agent.complete !== false) await assessAll(resources, c, run.id, { inputIds: ids, summary: String(result) || "Handled silently" });
          }
          sink({ kind: "agent_message", invocationId: input.invocationId,
            payload: { messageId: randomUUID(), phase: "commentary", content: [{ type: "text", text: "我先检查当前工作。" }] } });
          sink({ kind: "agent_message", invocationId: input.invocationId,
            payload: { messageId: randomUUID(), phase: "final", content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] } });
          finish(input.invocationId, "end_turn");
        }).catch(() => finish(input.invocationId, "error"));
        return { accepted: true, effective: "new_turn" };
      },
      async abort() { if (active) finish(active.invocationId, "cancelled"); },
      async close() { if (active) finish(active.invocationId, "cancelled"); },
    };
  } };
}
