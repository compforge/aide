# Aide 的执行内核

Aide 由 Channel、执行内核和 Plugin 协作。Channel 把外部消息带入宿主，Plugin 定义如何处理输入与推进资源，Harness 提供 Agent 执行能力。内核负责持久化、调度、交互和执行事实，让业务插件能够跨请求、跨时间继续工作。

```text
Web / Feishu Channel ──→ Conversation / Input / Message
                                  │
Aide Host                         │ 内置 Resource 投影
├── Resource 存储、Controller 队列与 Watch
├── Session / Lane / HarnessInvocation / Turn
├── Interaction 与 Harness Adapter ──→ Agent / CLI
└── Plugin Supervisor / IPC Client
                    ⇅ IPC
Plugin Runner
└── Plugin 回调：Source / Reconcile / Hook / Command
```

## 进程与所有权

Host 是主进程，拥有存储、队列、Harness 调用、用户交互与 Runner 生命周期。Runner 是加载插件并执行回调的子进程，通过公共 Resource API 和 verb 请求宿主能力。每个启用的插件实例有自己的 Runner；Harness 也可能创建子进程。

Host 与 Runner 不相互导入实现。Host 通过入口启动 Runner；两端共用的 IPC 与 verb 契约放在 `src/protocol/`，上下文构造放在 `src/plugin-context.ts`。插件开发者依赖 `packages/plugin/`，无需处理 IPC。插件运行细节见 [Plugin](plugin/README.md)。

## 输入与交流记录

Conversation 表达一组交流上下文，Input 表达一次待处理触发，Message 表达交流记录。Channel Input 引用用户 Message，Source Input 携带观察；外部观察不会自动成为一条聊天消息。

三者由 Host 的 ConversationStore 管理，以普通记录持久化，并通过内置 Resource API 提供访问与调度投影。它们不进入插件的 Resource 文件存储。输入状态和对应消息一起提交，避免只写完成状态却遗漏答复。

Conversation 的划分由输入方确定，消费顺序与处理策略由插件决定。Personal 的 Chief 按会话串行消费 Input；这是 [Personal](plugin/personal.md) 的业务约定。当前所有会话属于同一用户和同一执行身份，conversationId 不是权限边界。

## Harness 与执行事实

HarnessAdapter 统一启动、提交、取消、恢复和事件流。Target 标识一份具体执行配置，`harness` 字段选择 Harness；同一 Harness 可以有多个 Target。具体契约与职责见 [Harness](harness/README.md)，实现分别见 [Pi](harness/pi.md) 与 [Chief](harness/chief.md)。

Session 保存执行上下文和事件；Lane 组织一条执行支线；HarnessInvocation 表达执行请求；Turn 记录一轮执行事实。请求先持久化，再交给 Adapter。接受请求、执行结束和业务目标完成是不同事实，目标是否达成由调用方校验。

Adapter 保留提供方明确给出的消息阶段。`agentText` 用于整轮记录，`finalText` 仅包含明确标记的最终答复；未标阶段的文本不能靠位置猜成最终答案。流式内容先归一为执行事件，Channel 再投影为展示内容。

## 交互与恢复

Interaction 保存问题、答复、取消和超时。插件通过 ask / confirm / draft / harness 等 verb 请求动作，Host 管理交互与执行生命周期。等待 verb 时释放调度容量，执行调用栈仍由当前 Runner 持有。

Worker 或 Host 中断后不重放内存调用栈，未完成 verb 以 failure 收口。插件依据领域状态决定如何恢复；对于可能已经产生外部副作用的工作，Personal 保留待核对状态，规则见 [Personal](plugin/personal.md)。

Channel 从持久消息与执行投影恢复展示。浏览器断开不会取消服务端工作；消息投递失败也不能让已完成工作重新执行。当前网页 Interaction 收件区属于整个 Session，跨 Conversation 可见。Channel 接入与展示边界见 [Channel](channel/README.md)。

## 验证

`npm run check` 覆盖 IPC、注册撤销、资源冲突、队列、verb 等待与崩溃收口。真实模型、CLI 和外部平台的验证见 [E2E](e2e.md)；日志位置与运行诊断见 [部署](deployment.md)。
