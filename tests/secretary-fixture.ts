import { type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { PluginContext, ReconcileContext } from "@compforge/aide-plugin";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { routeTo, assessAll } from "./input-state-fixture.ts";
import { InputAttention, type InputOrigin, type InputSpec } from "../plugins/personal/input/model.ts";
import { topicPolicy } from "../plugins/personal/topic/config.ts";

export async function secretaryFixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-secretary-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("Unexpected Work"); } }, home), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  await aide.topics.ensure("root");
  const resources = aide.runtime.plugins.resourceClient("personal");
  const policy = topicPolicy({ deferred: { count: 2, maxWaitSeconds: 600 }, secretary: { count: 2, maxWaitSeconds: 600 } });
  const context = { resources, instance: { config: { topic: policy } }, logger: { info() {}, warn() {}, error() {} } } as unknown as PluginContext;
  const root = () => aide.topics.resource("root")!;
  const input = async (id: string, attention = InputAttention.Deferred, origin: InputOrigin = "source", originId = "fixture", extra: Partial<InputSpec> = {}) => {
    const item = await aide.topics.submit(id, { topicId: "root", origin, originId, attention, text: `evidence ${id}`, ...extra });
    await routeTo(resources, root().metadata, item);
    return aide.topics.inputStore.get(item.metadata.name)!;
  };
  let calls = 0;
  const execution = (id = "exec", onPrompt?: () => Promise<void>) => ({ executionId: id, withContext() { return this; }, verbs: {
    async action() { return { state: "success", value: { streaming: false } }; },
    async harness(args: { operation?: string }) {
      if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "chief", sessionId: "session" } };
      calls++;
      if (onPrompt) await onPrompt();
      else await assessAll(resources, root(), id, { inputIds: aide.topics.inputStore.list().filter(i => i.status.assess?.executionId === id).map(i => i.metadata.name), summary: "checked" });
      return { state: "success", value: { result: { stopReason: "end_turn" } } };
    },
  } } as unknown as ReconcileContext);
  return { aide, resources, root, context, policy, input, execution, calls: () => calls };
}
