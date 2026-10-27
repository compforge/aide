import assert from "node:assert/strict";
import { test } from "node:test";
import { requirementWatches, validateWatchScopes } from "../plugins/personal/source/requirement/config.ts";
import { parsePersonalConfig } from "../plugins/personal/config.ts";

test("Discovery requires an explicit assignee scope and unique watch identity", () => {
  const watch = { id: "mine", source: "work", userKeys: ["me"] };
  const watches = requirementWatches(parsePersonalConfig({ sources: { requirements: [watch] } }).sources.requirements);
  assert.equal(watches[0]!.intervalMs, 300_000);
  validateWatchScopes(watches, [{ source: "work" }]);
  assert.throws(() => validateWatchScopes(watches, []), /unknown connector/);
  assert.throws(() => parsePersonalConfig({ sources: { requirements: [{ ...watch, userKeys: [] }] } }), /userKeys/);
  assert.throws(() => parsePersonalConfig({ sources: { requirements: [{ id: "mine", source: "work" }] } }), /userKeys/);
  assert.throws(() => requirementWatches(parsePersonalConfig({ sources: { requirements: [watch, watch] } }).sources.requirements), /Duplicate/);
});

test("Watches sharing a connector get separate topics unless explicitly routed together", () => {
  const watches = requirementWatches(parsePersonalConfig({ sources: {
    requirements: [{ id: "mine", source: "work", userKeys: ["me"] }, { id: "team", source: "work", userKeys: ["team"] },
      { id: "urgent", source: "work", topicKey: "lark:bot:chat", userKeys: ["me"] }],
  } }).sources.requirements);
  assert.deepEqual(watches.map((watch) => watch.topicKey), ["source:mine", "source:team", "lark:bot:chat"]);
});
