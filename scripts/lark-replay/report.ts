import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Aide } from "../../src/app.ts";
import type { inputDetail } from "../../src/api/inputs.ts";

interface Result {
  state: string; failure?: string; revision: string; datasetHash: string; weave: boolean; batches: number;
  protocolFixture: boolean; startedAt: string; finishedAt: string; limitations: string[];
  coverage: Array<{ complete: boolean }>; excludedEdited: string[];
  topics: Array<ReturnType<Aide["topics"]["list"]>[number] & { uid: string; summary?: string }>; outputs: ReturnType<Aide["outputs"]>;
  inputs: Array<NonNullable<ReturnType<typeof inputDetail>>>; usage: Record<string, unknown>;
}
const inline = (value: string) => value.replace(/[\r\n]/g, " ").replace(/[\\`*_{}[\]<>|]/g, "\\$&");

/** @spec Reporting only reads recorded evidence; Output usefulness remains a human judgment. */
export function report(directory: string) {
  const result: Result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
  const roots = result.topics.filter(t => !t.parentRef);
  const unfinished = result.inputs.filter(i => !i.input.status.route?.completedAt
    || (!!i.input.status.assess && !i.input.status.assess.completedAt));
  const lines = ["# Lark 回放报告", "", `运行状态：${result.state}。${result.failure ? inline(result.failure) : ""}`,
    `代码：${result.revision}；数据集 SHA256：${result.datasetHash}。`,
    `Weave：${result.weave ? "开" : "关"}；完成批次：${result.batches}；协议替身：${result.protocolFixture}。`,
    `开始：${result.startedAt}；结束：${result.finishedAt}。`, "",
    `Input ${result.inputs.length}；未完成 ${unfinished.length}；Topic ${result.topics.length}；root ${roots.length}；Output ${result.outputs.length}。`,
    `采集缺口 ${result.coverage.filter(c => !c.complete).length}；排除编辑消息 ${result.excludedEdited.length}。`, "",
    "## Topic 树", "", "归组创建新父节点；root 减少不等于总 Topic 数减少。逐批变化见 batch-*.json。", ""];
  const render = (topic: Result["topics"][number], depth: number) => {
    lines.push(`${"  ".repeat(depth)}- ${inline(topic.name ?? topic.id)} (${topic.id})`, `${"  ".repeat(depth + 1)}${inline(topic.summary ?? "")}`);
    for (const child of result.topics.filter(t => t.parentRef?.uid === topic.uid)) render(child, depth + 1);
  };
  for (const root of roots) render(root, 0);
  lines.push("", "## Output（仅捕获，未对外发送）", "");
  for (const output of result.outputs) lines.push(`### ${output.id}`, "", inline(output.text), "",
    "人工标注：有用 / 已知且重复 / 不值得打扰 / 错误。依据和关联 Input 见 result.json。", "");
  lines.push("## 执行与覆盖", "", "```json", JSON.stringify(result.usage, null, 2), "```", "",
    ...result.limitations.map(l => `- ${l}`), "", "完整 Input Timeline、执行关联和失败记录见 result.json；工具调用及用量见 events.jsonl；原生会话见 pi/sessions。", "");
  writeFileSync(join(directory, "report.md"), lines.join("\n"), { mode: 0o600 });
}
