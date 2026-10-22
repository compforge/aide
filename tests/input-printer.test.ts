import assert from "node:assert/strict";
import { test } from "node:test";
import { type Resource } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../plugins/personal/input/model.ts";
import { inputPrinter } from "../plugins/personal/input/printer.ts";

function input(spec: Partial<InputSpec> = {}): Resource<InputSpec, InputStatus> {
  return { ...INPUT_TYPE, metadata: { name: "message-1", namespace: "v1", uid: "input:message-1",
    resourceVersion: "1", generation: 1, creationTimestamp: "2026-10-21T00:00:00Z" },
    spec: { origin: "channel", originId: "web", text: "第一行\n  第二行 <script>alert(1)</script>", ...spec }, status: {} };
}

test("Input descriptions preserve original text and optional opaque evidence without inventing context", () => {
  const plain = input();
  const described = inputPrinter.describe(plain);
  assert.match(described, /Input: message-1/);
  assert.match(described, /Origin: channel\/web/);
  assert.match(described, /Received: 2026-10-21T00:00:00Z/);
  assert.ok(described.endsWith(plain.spec.text));
  assert.doesNotMatch(described, /Observation:|Session:|Timezone:|Reply to:|Source resource:/);
  const evidence = { provider: "new-provider", message: { content: "@me 原文" }, context: { messages: ["之前的消息"] } };
  const source = input({ origin: "source", originId: "unknown.source", sessionId: "topic-1", timezone: "Asia/Shanghai",
    originRef: { apiVersion: "example.dev/v1", kind: "Source", name: "mine", namespace: "v1" }, observation: evidence });
  const before = structuredClone(source);
  const description = inputPrinter.describe(source);
  assert.match(description, /Origin: source\/unknown.source/);
  assert.match(description, /Session: topic-1\nTimezone: Asia\/Shanghai/);
  assert.ok(description.includes(JSON.stringify(source.spec.originRef)));
  assert.deepEqual(JSON.parse(description.split("\n\nObservation:\n")[1]!), evidence);
  assert.deepEqual(source, before);
});

test("Input summaries collapse whitespace and cap previews without truncating descriptions or splitting emoji", () => {
  assert.equal(inputPrinter.summarize(input({ text: "  hello\n\t世界  " })), "hello 世界");
  assert.equal(inputPrinter.summarize(input({ text: "😀".repeat(120) })), "😀".repeat(120));
  const long = input({ text: "😀".repeat(121) });
  assert.equal(inputPrinter.summarize(long), "😀".repeat(119) + "…");
  assert.ok(inputPrinter.describe(long).endsWith(long.spec.text));
});
