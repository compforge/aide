# Pi Harness

Pi 是通用 Harness，使用 `agents/pi/` 中的 Pi Agent 和 `PiAdapter` 提供模型对话、文件与 CLI 操作。它不依赖 Personal，也不预装 Work、问答或 Connector 业务工具。共同执行契约见 [Harness](README.md)，Personal 的专属 Agent 见 [Chief](../personal/chief.md)、[Task](../personal/work.md#task) 和 [Routine](../personal/work.md#routine)。

## 会话与能力

通用 Agent 创建 Pi SDK 会话，加载工作目录上下文与 Skills，启用文件和 CLI 原生工具。调用方可以注入提示词、工具与会话范围。默认使用 Pi 的提示词，不承担 Chief 的工作识别与主动发现策略。

PiAdapter 实现 Harness 的 create、resume、prompt、followUp、steer、abort、close，负责事件归一和恢复引用，不解释工具背后的业务含义。一个 HarnessInvocation 可通过 Pi 原生 followUp 接收后续普通输入，通过 steer 接收紧急输入；宿主不复制 Pi 的追加队列。原生消息事件按投递 ID 确认输入已应用，结束时清理未应用队列并报告失败。不声明媒体能力。

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

Personal 在首次 prompt、steer 和 followUp 中通过 `aide.input` 投递业务 Input。模型读取正文，Pi 原生条目的 details 保存 deliveryId、各 Input 的身份与来源，以及可选的 Batch ID。Adapter 在原生消息到达时确认应用；Gate 和 Chief 用同一 ID 提交投递回执。重启后按原生记录补回执，旧会话兼容原有 user 消息前缀。定时唤醒继续使用激活指令。Weave 的候选批次和 Route 的 root 目录使用 `aide.topic-directory`，分别标明目录范围。

每次模型请求前，`agent.transformContext` 读取当前 Background，把各部分作为 custom message 注入历史前缀。Chief 读取 `aide.topic`，Task、Routine 还分别读取 `aide.task`、`aide.routine` 委托快照。通用文本背景沿用 `aide.background`。Pi 将正文转换为模型消息；system 继续承载指令和工具。前缀由业务资源重建，覆盖工具后续轮次、followUp、steer 和 resume。原生历史只保留实际投递与读取的记录，当次注入的背景可从请求观察中核对。

读取单个 Topic、Note 或 Work 时，工具在原生 toolResult 中保留原调用关系和本次返回的正文，details 标识快照种类、UID 和适用版本。Note 使用所读的内容版本；Task、Routine、Ongoing 共用 Work 读取入口。分页和目录遵守各工具的范围，列出对象仅代表可发现。业务消息定义见 [Personal messages](../../plugins/personal/messages.ts)。

Pi 原生观察和恢复支持 aide.input。当前使用的 pi-hermes-memory 0.9.10 仅将普通 user、assistant 和 system 会话条目纳入 session_search，故新增的 aide.input 正文须通过业务 Input 查询。该扩展按 user 事件触发的纠错检测和轮次计数也采用自身的角色过滤。

读取当前背景失败会终止本次推理，避免带着旧事实继续。快照生成之后资源仍可能变化，写入工具继续校验 UID、版本和执行归属。动态前缀也占上下文预算；Personal 提供有界预览和分页补查，不把常驻背景当作额外授权。

Note 目录属于每次请求刷新的业务背景：条目增减或改名会替换该 part，不重写历史消息。prefix cache 复用与最新信息之间的取舍由业务背景预算决定，观察请求 token、缓存使用和延迟评估效果。

## 压缩与失败恢复

Pi 原生管理上下文压缩与 checkpoint。使用 Pi 1.4.0 的摘要预算：`reserveTokens` 决定压缩触发时机，摘要输出受模型能力与实际请求剩余空间约束，不再额外限制为 `0.8 × reserveTokens`。模型的 `contextWindow` 和 `maxTokens` 仍需按实际服务配置。

压缩最终失败时（非取消且不再由 Pi 内部重试），Adapter 终止当前调用，报告 `HarnessError`，code 为 `harness_compaction_failed`；未应用的 followUp / steer 按失败回执清理。IPC 保留分类、原始安全诊断和原生会话引用。Adapter 不替换 session，也不保存不完整摘要。

Personal 将失败原因保存到未完成 Input、Topic 和中断 Stream，并在同一资源事务中结束 execution、移除匹配的 `status.agent`。匹配要求资源 UID、executionId、harness 和 sessionId 一致，迟到的失败不得移除较新的绑定。随后只关闭旧运行实例，保留原生文件和 Input 中的 session 引用；关闭异常单独记日志，不覆盖原始失败或重新绑定。

失败收尾不创建新 Agent、不重放已失败 Input，也不为该压缩错误安排 Route 重试或设置 Work 的恢复阻塞。后续新 Input 或正常定时触发独立经过 `prepareAgent`，发现没有绑定便按正常流程创建 session，并从当前业务资源组织 Background。其它失败仍沿用原处理规则，用户取消不会触发绑定清理。

这是 Personal 避免持续卡在同一份历史上的兜底策略，不意味着原生文件损坏。即使压缩失败是偶发错误，也会放弃该绑定；尚未沉淀到业务资源的临时上下文不会自动带入新 session。

压缩日志记录 sessionId、invocationId、触发原因，以及成功时的压缩前后 token 估计和摘要字符数；失败时记录原生错误。日志不包含摘要正文。

## 输出与验证

Adapter 将文字、思考、工具和用量转换为 Core 事件。多轮工具调用中的中间发言保留为进度，只有成功收口的最后答复进入 finalText；失败、取消、截断或空答复不作为成功结果。原生调用栈清理完毕后才释放执行位。

`tests/pi-agent.test.ts` 使用真实 SDK 与模拟模型验证通用工具集合、原生历史恢复、范围拒绝、流式输出、失败与取消。Chief 复用这套机制，其业务链路和优化方向见 [Chief](../personal/chief.md)。
