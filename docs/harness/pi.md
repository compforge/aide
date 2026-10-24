# Pi Harness

Pi 是通用 Harness，使用 `agents/pi/` 中的 Pi Agent 和 `PiAdapter` 提供模型对话、文件与 CLI 操作。它不依赖 Personal，也不预装 Work、问答或 Connector 业务工具。共同执行契约见 [Harness](README.md)，Personal 的专属 Agent 见 [Chief](../personal/chief.md)、[Task](../personal/task.md) 和 [Routine](../personal/routine.md)。

## 会话与能力

通用 Agent 创建 Pi SDK 会话，加载工作目录上下文与 Skills，启用文件和 CLI 原生工具。调用方可以注入提示词、工具与会话范围。默认使用 Pi 的提示词，不承担 Chief 的工作识别与主动发现策略。

PiAdapter 实现 Harness 的 create、resume、prompt、followUp、steer、abort、close，负责事件归一和恢复引用，不解释工具背后的业务含义。一个 HarnessInvocation 可通过 Pi 原生 followUp 接收后续普通输入，通过 steer 接收紧急输入；宿主不复制 Pi 的追加队列。原生 user message 事件确认输入已应用，结束时清理未应用队列并报告失败。不声明媒体能力。

## 装配与模型配置

根级 `defaultHarness` 选择 `pi`（缺省值）时，通用执行请求使用 Pi；Personal 的 Task / Routine 始终使用各自的专属 Agent。Aide 在启动时从 `harnesses.pi.model` 和 `harnesses.pi.packages` 准备模型与技能；能力包通过 `aide harness sync pi` 显式同步，与 Chief 分别存放。

通用 Pi 也可以直接通过注册表创建，不需要 Personal：

```ts
const piConfig = await resolvePiConfig({ cwd });
const adapter = createHarnessAdapter(
  { id: "general", harness: "pi" },
  { ...ports, piConfig, targetConfig: { harness: "pi" }, rootDir: aideHome },
);
```

启动装配调用 `resolvePiConfig` 读取 Pi settings/models 并应用显式覆盖，传入 `piConfig`。需要绑定自定义工具时提供消费该配置的 `piSession` 工厂。模型定义和 settings 保留在内存中，SDK refresh 不重新读取原文件；认证沿用 Pi auth.json 和 SDK 的刷新机制，默认目录为 `~/.pi/agent`。嵌入式 SDK 不支持每会话环境覆盖。配置格式见 [Pi 上游文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)。

原生会话使用 SDK 的 SessionManager 持久化在 `<agentDir>/sessions/`。创建时经 SDK 写入一条真实的初始化指令，要求等待后续工作、不要执行外部动作；不请求模型，也不伪造助手历史。这使 create 返回的 sessionId 在首次推理之前即可跨重启恢复。Harness 用 SDK 的 findById/open 按 ID 定位并恢复，校验工作目录和调用方绑定的 scope；历史缺失或范围不符明确报错。Aide 不直接编辑原生会话文件，Operator 只保留 harness 和 sessionId。通用 Pi、Chief、Route、Task、Routine 共用这条路径。

Agent 不自动发现环境中的扩展、提示词命令或交互主题；装配方可通过 extensionPaths 显式提供扩展路径，工具和钩子由 Pi SDK 加载。Adapter 负责扩展启动与退出事件。通用 Pi 默认不携带记忆扩展，并禁用自动整轮重试。完整执行期限由 Harness 调用方管理。

## 当前业务背景

上下文分为三个层次：system 保存固定 instruction、tools 和 rules；custom 保存当前业务背景，在 LLM 侧转换为 user；普通 user 消息承载陆续到达的 Input。业务背景可以包含候选会话、当前 CRD 的 summary、近期依据和相关工作，具体内容由业务决定。

`Background` 是本次请求的业务快照，提供 `text(): string`。调用方通过 `createPiAgent({ background: () => new TopicBackground(...) })` 提供它；工厂读取最新资源，`text()` 只文本化快照，Harness 不解释其中的业务字段。

Personal 的 Route、Topic、Task、Routine 分别在自己的目录实现 Background，共用有界投影与文本组织辅助函数；它们是派生对象，不是新的 CRD，也不单独持久化。

公开的 `agent.transformContext` 在每次模型请求前调用工厂、取得 `Background.text()`，作为一个 custom message 投影到历史消息之前，包括工具后续轮次、followUp 和 steer。SDK 仍负责 system、工具声明和原生消息转换；业务材料不写进 system。内容不变时前缀保持相同，变化时下一次请求使用新内容，移除的 part 不再提供。

这个前缀是当前资源的派生视图，不追加到原生 transcript，因此不会积累多个旧快照，也不参与历史压缩。压缩保留对话、工具与回执的摘要；恢复时从 CRD 重建当前背景。Aide 不编辑原生会话文件，不存另一套快照历史或模型已读版本。排查当次背景应查看实际模型请求，原生 transcript 只反映历史事实。

读取当前背景失败会终止本次推理，避免带着旧事实继续。快照生成之后资源仍可能变化，写入工具继续校验 UID、版本和执行归属。动态前缀也占上下文预算；Personal 提供有界预览和分页补查，不把常驻背景当作额外授权。

## 压缩与失败恢复

Pi 原生管理上下文压缩与 checkpoint。使用 Pi 1.4.0 的摘要预算：`reserveTokens` 决定压缩触发时机，摘要输出受模型能力与实际请求剩余空间约束，不再额外限制为 `0.8 × reserveTokens`。模型的 `contextWindow` 和 `maxTokens` 仍需按实际服务配置。

压缩失败时，Adapter 终止当前调用并报告错误，未应用的 followUp / steer 按失败回执清理；不会把失败状态永久保存在 session 上。后续显式调用继续使用同一个原生 session，由 Pi 决定是否需要再次压缩。Aide 不自动重放失败输入、不替换会话，也不保存不完整摘要。Chief / Work 对可能已有副作用的输入仍要求核对。

压缩日志记录 sessionId、invocationId、触发原因，以及成功时的压缩前后 token 估计和摘要字符数；失败时记录原生错误。日志不包含摘要正文。

## 输出与验证

Adapter 将文字、思考、工具和用量转换为 Core 事件。多轮工具调用中的中间发言保留为进度，只有成功收口的最后答复进入 finalText；失败、取消、截断或空答复不作为成功结果。原生调用栈清理完毕后才释放执行位。

`tests/pi-agent.test.ts` 使用真实 SDK 与模拟模型验证通用工具集合、原生历史恢复、范围拒绝、流式输出、失败与取消。Chief 复用这套机制，其业务链路和优化方向见 [Chief](../personal/chief.md)。
