import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import pino from "pino";
import { Aide } from "../src/core/aide.ts";
import { PersonalAgent } from "../src/core/agent.ts";
import { Store } from "../src/core/store.ts";
import { httpChannel } from "../src/channel/http.ts";
import type { StructuredRequest } from "../src/harness/types.ts";

test("HTTP input -> model routing -> persisted task -> execution -> outgoing message", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aide-channel-"));
  const requests: StructuredRequest[] = [];
  const log = pino({ level: "silent" });
  const agent = new PersonalAgent({ generate: async (request) => {
    requests.push(request);
    return requests.length === 1
      ? { action: "create", kind: "task", workId: null, title: "工作总结", instruction: "读取今日工作并总结", trigger: null, response: "开始整理" }
      : { action: "done", summary: "Read work log", notification: "今天完成了三件事", question: null, nextAt: null };
  } }, { cwd: dir, timezone: "Asia/Shanghai" });
  const aide = new Aide(new Store(join(dir, "state.json")), agent, log);
  const server = httpChannel(aide, log);
  t.after(async () => {
    await aide.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  aide.start();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${url}/messages`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "msg-1", conversationId: "me", text: "总结今日工作" }),
  });
  assert.equal(response.status, 200);
  const ack = await response.json() as { id: string; workId: string };
  await aide.settled();
  const outgoing = await (await fetch(`${url}/messages?conversationId=me&after=${ack.id}`)).json() as { text: string }[];
  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0]?.text, "今天完成了三件事");
  const works = await (await fetch(`${url}/work?conversationId=me`)).json() as { status: string; id: string }[];
  assert.equal(works[0]?.status, "done");
  assert.equal(works[0]?.id, ack.workId);
  assert.equal(requests[0]?.sandbox, "read-only");
  assert.equal(requests[1]?.cwd, dir);
  assert.match(requests[1]!.prompt, /读取今日工作并总结/);
  assert.equal((await fetch(`${url}/messages?conversationId=me&after=missing`)).status, 400);
  assert.deepEqual(await (await fetch(`${url}/work?conversationId=other`)).json(), []);
});
