import { inputPreview } from "../plugins/personal/input/prompt.ts";
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
  assert.doesNotMatch(described, /Observation:|Topic key:|Timezone:|Reply to:|Source resource:/);
  const evidence = { provider: "new-provider", message: { content: "@me 原文" }, context: { messages: ["之前的消息"] } };
  const source = input({ origin: "source", originId: "unknown.source", topicKey: "topic-1", timezone: "Asia/Shanghai",
    originRef: { apiVersion: "example.dev/v1", kind: "Source", name: "mine", namespace: "v1" }, observation: evidence });
  const before = structuredClone(source);
  const description = inputPrinter.describe(source);
  assert.match(description, /Origin: source\/unknown.source/);
  assert.match(description, /Topic key: topic-1\nTimezone: Asia\/Shanghai/);
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

/** @case Large evidence stays queryable without entering automatic model material. */
test("automatic Input preview preserves identity and text but excludes full observations", () => {
  const fact = input({ origin: "source", originId: "personal.environments", relation: "observed", topicKey: "topic",
    text: "api: restart +1; readiness unchanged", observation: { changes: [{ before: "private-evidence-marker".repeat(2000), after: "full-evidence" }] } });
  const original = structuredClone(fact);
  const preview = inputPreview(fact, 1000);
  assert.match(preview, /api: restart \+1/);
  assert.match(preview, /Topic key: topic/);
  assert.match(preview, /Relation to Person: observed/);
  assert.match(preview, /read_input/);
  assert.doesNotMatch(preview, /private-evidence-marker|full-evidence/);
  assert.match(inputPrinter.describe(fact), /private-evidence-marker/);
  assert.deepEqual(fact, original);
  assert.ok(preview.length < inputPrinter.describe(fact).length / 20);
  const long = inputPreview(input({ text: "x".repeat(5000), observation: { evidence: true } }), 1000);
  assert.ok(long.length <= 1000);
  assert.match(long, /Text truncated/);
  assert.match(long, /observation evidence/);
});

/** @case The same sent relation is not enough to tell an external statement from a request to Aide. */
test("preview distinguishes Me, the channel assistant and the credential observer without exposing other evidence", () => {
  const observation = { provider: "lark", accountId: "cli_scope", chatId: "oc_chat", chatType: "group",
    sender: { type: "user", id: "ou_me" }, assistant: { id: "ou_bot", name: "Aide" }, mentions: ["ou_bot", "ou_peer"],
    privateEvidence: "must-stay-out-of-preview" };
  const direct = input({ originId: "lark", relation: "sent", text: "按你的建议帮我做", observation });
  const preview = inputPreview(direct);
  assert.match(preview, /Message accepted by Aide's Lark channel/);
  assert.match(preview, /"accountId":"cli_scope"/);
  assert.match(preview, /"sender":\{"id":"ou_me","type":"user"\}/);
  assert.match(preview, /"assistant":\{"id":"ou_bot","name":"Aide"\}/);
  assert.match(preview, /"mentions":\["ou_bot","ou_peer"\]/);
  assert.doesNotMatch(preview, /must-stay-out-of-preview/);
  const source = inputPreview(input({ origin: "source", originId: "personal.lark-messages", relation: "sent",
    text: "李乾坤对同事说：我来弄下", observation }));
  assert.match(source, /External observation/);
  assert.doesNotMatch(source, /Message accepted by Aide|"assistant"/);
  const unknown = inputPreview(input({ originId: "lark", observation: { ...observation, assistant: undefined } }));
  assert.doesNotMatch(unknown, /ou_bot.*name|"assistant":/);
  const broken = inputPreview(input({ originId: "lark", observation: { provider: "lark", sender: "unknown" } }));
  assert.match(broken, /Participant details unavailable/);
  assert.match(inputPreview(input({ origin: "chief", originId: "chief" })), /Originating actor: Aide/);
  assert.match(inputPreview(input()), /Me → Aide/);
  assert.ok(inputPreview(direct, 400).length <= 400);
});
