# Aide 的运行机制

Aide 通过 Channel 接收用户消息，以 Plugin 表达业务职责，由 Host 调度 Harness 完成工作。`src/channel/` 承载网页与飞书适配器，`plugins/personal/` 负责个人助理业务，`src/host/` 提供主进程的执行与持久化能力，`src/runner/` 承载插件子进程实现。两端共用的通信契约和上下文构造按职责独立放在 `src/` 下。插件通过 `@compforge/aide-plugin` 公共契约接入。

```text
Aide Host（主进程）
├── 网页 / 飞书 Channel → Input
├── Aide Session / Channel / Controller
│   ├── PiAdapter → Chief → 对话 / Connector / Work 工具
│   └── CodexAdapter → codex app-server → CLI
└── Plugin Manager / Supervisor / IPC Client
    └── Resource store / Controller 调度 / Source / Watch / cron / queue
             ⇅ IPC
Plugin Runner（独立 Bun 子进程）
└── personal Plugin
    ├── Source Controller → Connector → Input
    ├── Chief Controller → verbs.harness / ask / confirm
    └── Work Controller   → verbs.harness → 推进 Task / Routine
```

## 职责边界

Host 决定何时调度回调、保存 Resource 和执行事实，并负责 Harness 调用、用户交互以及子进程生命周期。Runner 加载 Plugin，执行 Source、Reconcile、Hook 等回调，经 IPC 访问宿主能力。当前 personal Instance 对应一个 Runner；增加插件实例时可以启动更多 Runner，并非整个 Aide 永远只有两个操作系统进程，Harness 也可能创建自己的子进程。

`src/host/plugin/runner/` 是宿主侧的 Supervisor、IPC Client 和注册代理。`src/runner/process.ts` 只作为子进程入口启动，Host 与 Runner 不相互导入实现。双方共享 `src/protocol/` 中的 IPC 与 verb 契约，以及 `src/plugin-context.ts` 中的上下文构造和参数校验；共享模块不加载 Host 或 Runner 实现。`packages/plugin` 面向插件开发者，`src/protocol` 是 Aide 内部通信契约，插件不需要了解 IPC。此目录拆分保持原有 IPC 消息和执行行为不变。

Harness 消息的 `phase` 区分进度说明（`commentary`）与最终答复（`final`）。Adapter 保留提供方明确给出的阶段；没有阶段时保持未知，不根据消息位置或文本内容推断。Codex 的实时消息和历史导入共用同一映射。

Turn 的 `agentText` 是整轮对话文本，用于上下文与查看记录；`finalText` 只包含明确标记的最终答复，随汇总持久化并经 Harness verb 交给 Plugin。Work Controller 仅解析 `finalText` 的 JSON，执行结束但答复缺失、格式或业务结果字段不合法时记录为 `invalid_result`，保留 Lane 和 Turn 线索。执行失败或中断仍记录为 `uncertain`。两者都等待用户明确继续，不自动重放外部动作。

执行内核管理 Runner、Supervisor、IPC、注册与撤销、Resource、Controller、Source、Watch、cron、队列、容量、退避和 verb 生命周期。Harness 通过 Adapter 接入，Session Binding、HarnessInvocation、Turn 和事件流承载执行状态。

Plugin 只经公共 Resource API 和 `ReconcileContext.verbs` 与宿主协作。Worker 不持有宿主 Store、Harness 进程或 SDK。宿主通过原有 Channel 装配 Plugin Manager 与 Harness Controller，执行先持久化，再交给 Adapter；接受请求与执行完成是不同事实。

Aide 当前装配一个常驻 Session、一个 personal Instance、一个 Codex Target 和按会话绑定的 Chief Pi Target。Chief 每个输入建立独立 Lane，问答续轮保留同一 Lane；每项工作首次执行通过 `newLane: true` 创建支线，后续继续同一 Lane，避免每次触发都创建新的执行会话。

网页通过 `/interactions` 展示当前 Session 的待决请求，并经原有 `Channel.resolveInteraction` 回答，不另建审批状态。当前支持 Hooks 信任、工具权限选择、问题答复与取消；其它原生交互会展示内容但暂只能取消。这个收件区属于同一个本地用户，跨 personal 对话可见；当前的 conversationId 只是对话分组，不是用户隔离边界。

## Personal 工作流程

1. Channel 按会话和消息 id 去重，持久化 Input 并立即返回回执。Source 按外部身份与观察指纹去重，同样提交 Input。
2. Chief Controller 观察内置 Conversation 的变化，按会话串行消费待处理 Input，通过 Harness 调用 Pi。普通问答直接进入消息 outbox；需要跟进时由 Work 工具创建、读取、更新或删除工作。Task 与 Routine 共用 Work 身份，`spec.kind` 区分两类，转换保留 uid 与历史。Chief 的问题通过 Core ask/confirm 等待答复，模型执行位先释放。
3. Work Controller 观察 ready 或已到期的 scheduled，先保存 running，再请求 Harness 执行。正常结果、问题和状态一起写入 status。IPC 等待期间用户可能更新指令，提交结果前按 uid 重新读取资源，保留最新指令和暂停状态；版本冲突只重试提交，不重复执行外部工作。
4. ask 保存为 waiting 并结束本次调用，用户回答再唤醒。wait 返回动态唤醒时间；Routine 单次完成后保留安排，Task 则结束。事件触发改变 Work，并经过同一队列和 Reconcile。

Chief 输入执行失败或被中断后标记 failed，不自动重放工具。同一消息 id 的重投只返回原入站回执；业务重试需要用户核对后新发消息。重启不恢复等待中的问答调用栈，Core 问题收口并提示重新交办。

宿主端使用 Aide 的 `replaceSpec` 和 `patchStatus` 顺序提交用户更新；status、回复和输入去重记录在同一次 status 写入中提交。没有增加跨 spec/status 的事务接口。

Conversation / Input / Message 由 Host 的 ConversationStore 持久化，内置 Resource 只是访问和调度投影。Channel Input 引用 Message；Source Input 保存观察；输入状态与回复消息一起提交。网页读取 Conversation 消息、Work outbox 及 Core 问题投影。消息是持久事实，浏览器关闭不影响服务器工作。按绿地方式开发，不迁移早期 Aide 数据布局。

## 生命周期与故障

Worker 按 PluginInstance 激活，完成后注册封口。Source、Watch、Hook、Command 和 Reconcile 跨 IPC 执行；资源存储与调度留在宿主。等待 verb 时释放 Controller 和 Manager 的执行容量，verb 自己的 timeout 覆盖完整等待过程。

Worker 崩溃或超时后撤销 Binding、让未完成 verb 以 failure 收口，并取消关联执行；不自动重启 Worker，也不恢复调用栈。personal 宿主端把运行中事项标为 uncertain。重启 Aide 会创建新 Worker，但不会重复执行这些事项，用户核对外部结果后再明确要求继续。

Chief 每轮 Harness timeout 为 3 分钟，Core 问题为 24 小时，工作执行为 15 分钟。Aide 通过宿主现有 policy 自动批准自身发起的 Harness invocation，仍记录 Interaction 决议；不新增账号权限管理。Harness 原生权限与 CLI 凭证沿用执行环境。

## 验证与诊断

`npm run check` 执行类型检查和测试。内核测试覆盖 IPC、注册撤销、资源冲突、Source / Watch、调度、verb 等待与崩溃收口；业务测试通过真实 Worker 和模拟 Adapter 覆盖网页交办、问答恢复、转换、事件去重、并发更新及 Worker 被杀后的 uncertain 恢复。

HTTP 和 personal 宿主日志进入标准输出；Aide 执行与 Plugin 日志保存在 AIDE_HOME 下 Session 的 `session.log`，执行事实在 `session.jsonl`。Worker 激活日志记录 pid，可与服务进程区分。真实 Codex 和业务 CLI 连通需要部署后的单独验证。
