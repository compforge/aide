# Lark 历史消息回放

用同一份消息快照运行 Weave 关闭、开启两组实验，观察 Topic 归组、后续 Input 的 root 研判与 Output 质量。回放使用真实 MessageSource、Route、Chief、Weave 和 Pi SDK；自动测试中的协议替身只证明数据链路，不代表真实模型效果。

## 准备

在安装好依赖、已通过 `lark-cli` 用户身份授权的机器运行。采集复用 `connectors.lark` 的 appId、userId、Me 身份和超时配置；不会启用配置里的其他 Connector 或 Source。每个查询串行分页，`--max-pages` 默认 100，是单个查询的上限。先选半天做小样本，再扩大时间范围。

产物含私人消息、人物资料和模型输出，放在已忽略的 `.e2e-runs/`，不要提交。快照文件权限为 600，运行目录为 700。命令不覆盖已有快照或运行目录。

初始化在写入 `manifest.json` 前失败时，会清理本次创建的目录，修正模型配置或凭证后可使用同一路径重试；已有目录不会被清理。manifest 写入后保留运行目录与失败证据，重跑需使用新目录。命令退出时恢复环境变量和 umask；每次实际回放仍应使用独立 CLI 进程，避免复用 Hermes 的模块级初始化状态。

```sh
mkdir -p .e2e-runs/lark-replay
npm run replay:lark -- collect --config ~/.aide/config.yaml \
  --start 2026-10-19T00:00:00+08:00 --end 2026-10-19T12:00:00+08:00 \
  --out .e2e-runs/lark-replay/messages.json
```

快照分别保存搜索命中和上下文；群聊普通消息只作为上下文，不冒充 @Me 的独立输入。采集记录分页、权限失败和截断。发现范围不完整时回放拒绝启动；实际读取的 history/thread 范围存在缺口时，回放以 error 结束，保留缺口范围与采集证据，重新采集后再比较。分页的 hasMore 只表示快照中还有可读消息，不承担覆盖缺口语义。不同读取之间内容变化会记录缺口，应重新采集。

每个命中触发消息的聊天只采一次历史，范围从最早触发前 15 分钟到采集截止时间；相关 thread 单独分页读取。这样既减少重叠请求，也覆盖批量发现后可能需要的讨论跟进。未命中触发消息的聊天不扩展采集。

历史 API 无法还原编辑前内容，`updatedAt > createdAt` 的消息排除出回放并列入报告。分钟精度时间戳内用消息 ID 确定稳定顺序，不声称恢复了真实发送先后。

## 回放

准备独立的模型 JSON，字段遵循 Aide Pi 模型配置。例如：

```json
{
  "provider": "openai",
  "id": "YOUR_MODEL_ID",
  "api": "openai-responses",
  "baseUrl": "https://api.openai.com/v1",
  "apiKeyEnv": "REPLAY_MODEL_API_KEY"
}
```

从既有凭证管理方式设置环境变量，文件里只保存变量名。所有角色使用这一份显式模型配置；不加载用户 Pi 的模型、会话、技能或记忆，也不加载工作目录上层的 AGENTS.md / CLAUDE.md。

```sh
npm run replay:lark -- replay --dataset .e2e-runs/lark-replay/messages.json \
  --run .e2e-runs/lark-replay/off --model /path/to/model.json --weave off --batch-size 20
npm run replay:lark -- replay --dataset .e2e-runs/lark-replay/messages.json \
  --run .e2e-runs/lark-replay/on --model /path/to/model.json --weave on --batch-size 20
npm run replay:lark -- report --run .e2e-runs/lark-replay/off
npm run replay:lark -- report --run .e2e-runs/lark-replay/on
```

每批推进到第 N 条触发消息的时间；同一时刻的消息一起可见。Source 分页全部接纳后，等待 Input 回执、Chief 执行和 Weave 扫描完成，再推进下一批。重叠扫描保留生产去重语义。首轮建议使用多批消息，让归组后还有新 Input 到达；不要一次灌完再只看最终树。

运行目录独占 SQLite、工作目录、原生 Pi 会话及 Hermes 记忆。不会启动 Lark bot、外部投递器或实时 Source。模型工具只允许快照读取、本地理解更新、研判、归组及 `say`；禁用 shell、文件工具、工具发现和 Work 修改，也拒绝启动 Task / Routine / 通用 Harness。`say` 保留真实 Output 对象及目标，投递保持未完成；不伪造已发送回执。

## 结果与验收

两组实验均关闭 Hermes 的后台 review、纠错检测和退出/压缩 flush，以免产生额外未归属的模型调用；会话检索仍指向各自的运行目录。

`manifest.json` 保存模型选择、代码 revision、工作区是否有修改、数据集 SHA256 和参数。`result.json` 包含 Input Timeline、Topic 理解、Output、执行关联、用量和覆盖缺口。`batch-*.json` 保存每批树及输出，`events.jsonl` 保存工具调用和模型用量，`pi/sessions` 保留 SDK 原生会话。`report.md` 从这些事实生成树、输出与人工评价入口，不会再次调用模型。

重点检查：

- 同一来源 Input 绑定是否稳定，归组后的新 Input 是否由共同 root Chief 研判。
- 是否把确有关联的线索归到一起，同时保留不同来源、争议和未解问题；用无关来源检查误合并。
- Output 是否有原始消息依据、提供新认识或可行动建议，是否重复打扰。人工标注“有用 / 已知且重复 / 不值得打扰 / 错误”，另记遗漏的重要线索。
- 按角色比较模型调用和 token，以及工具重复读取；root 数量降低不能单独证明质量改善。

Weave 只组织主题，不直接产生 Output，也不会仅因为归组就唤醒无新 Input 的 Chief。报告里的 Output 是实际回放产生的，未额外注入“总结一下”的提示词。

### 助理身份与归属回归

使用固定快照覆盖“同事提出建议 → Me 对同事承诺推进”的外部交流，检查 Source 预览逐条保留作者和关系。对比叶子 Topic、Weave 父 Topic、Person 认识和 Output：不能把外部提问当成对 Aide 提问，不能把 Aide 补充的方案写成 Me 的方案或已确认委托。若模型选择静默、没有生成建议，该轮不能证明建议经过归并仍能保持归属。

对照场景在独立测试实例通过 Web Channel 明确交办：Me 采纳 Aide 的某一建议，并限定交付范围。核对 Chief 能在授权范围内办理或创建工作，而非因身份约束拒绝一切主动行为；记录提出者、采纳者和执行者，不能将采纳追溯为原创。此对照使用 [真实 Channel 验收](e2e.md) 的隔离实例，不能把合成 Channel 输入伪装为采集到的历史消息。

归并后的延续验证需要有来自已归组子 Topic 的后续 Input；若原快照没有这一条件，单独标注未覆盖。Work 修改在历史回放中禁用，未创建 Work 不能单独证明模型不会误委托；需要同时检查工具尝试，并在允许本地工作执行的隔离对照中验证。协议替身测试只验证提示词、身份材料和数据链路，真实模型判断以原生会话与持久结果为准。

`result.json.source` 保留 Source 水位和未结束的讨论跟进。数据截止时尚未经过完整跟进窗口的消息不等于已覆盖未来讨论；回放不会为了结束它们而读取截止日期之后的内容。

回放将 Weave 检查周期缩短为 1 秒，阈值和归组规则沿用默认值。只有 Source 的观察时间被推进，资源时间、模型时间和调度时间仍是真实运行时间；这不是生产延迟、吞吐、定时任务或七天 GC 的测试。每批默认最多等待 180 秒，`--timeout-ms` 最低 5000，包含处理与 2200ms 静默确认的时间；低于下限在启动前拒绝。超时记为 error 并保存未完成回执。结果 completed 只表示该回放链路完成，不代表 Output 质量通过。真实 Lark 采集、真实模型推理和自动协议测试必须分别报告。
