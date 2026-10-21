# Plugin 运行机制

Plugin 是业务扩展的组织与所有权单位。插件声明资源和回调，Core 提供持久化、调度、Harness 与交互能力。Personal 是 Aide 的一个内置 Plugin，负责个人助手的业务判断；通用运行机制可以承载其它插件。

## Package、Instance 与 Runner

`PluginPackage` 通过 `activate(context)` 注册 Resource Controller、Printer、Source、Watch、Hook、Command 等能力。Package 描述插件代码，一份启用配置对应一个 PluginInstance；Host 为实例建立 Binding 并启动独立 Runner，加载插件后完成注册。

Host 的 Supervisor 管理 Runner 和 IPC。Runner 运行 Source、Watch、队列、重试和 Reconcile；资源存储、全局 Connector 与执行事实由 Host 持有。PluginContext 将资源操作、Connector 查询和 verb 转成跨进程请求，插件无需引用宿主 Store、提供方客户端或 Harness SDK。

实例关闭或 Runner 失败时，Host 撤销注册并终止未完成调用。Runner 不自动重启；重新启动 Aide 会重新激活插件。回调中的内存状态与异步调用栈不会跨重启恢复。

## Resource 与 Reconcile

Resource 用类型、namespace、name 和 uid 表达身份，spec 保存目标，status 保存插件的业务进展。一个 Controller 拥有一种资源类型的 Reconcile：每次读取当前事实，推进目标，再持久化结果或安排下次唤醒。

每种 CRD 在所属 plugin package 下有一个按资源命名的目录，集中保存模型、Reconcile 和专属辅助代码。例如 `plugins/personal/conversation/` 包含 Conversation 的模型、输入追加、存储、触发配置和 Reconcile。Personal 的 Source 集中在 `plugins/personal/source/`：`definition.ts` 声明来源分类，`environment/`、`message/`、`requirement/` 分别保存对应 CRD 的配置与观察逻辑，消息上下文归入 `message/context.ts`。插件装配与跨资源流程留在插件层；目录内的 Runner 代码仍只经 ResourceClient 访问资源，不导入宿主存储实现。

资源变化、Source、Watch、cron 和 `requeueAfterMs` 共用按资源身份去重的队列。同一资源串行处理；不同资源受 Controller 与所在 Runner 的容量约束。基础设施回调重试不保证外部操作只发生一次，插件须保存已进入执行的状态，避免把重试变成业务重放。

资源写入统一经过 Core ResourceClient，包括 Agent 工具和 Reconcile，使用版本检查并通知所有相关 Watch。spec 与初始 status 可以原子提交。主资源的纯 status 更新不自动再入队；需要感知 status 的 Controller 显式声明 Watch。跨越 Harness 或用户等待后，应按 uid 重新读取资源，避免旧回调更新同名替代资源。删除先持久化 deletionTimestamp，Controller 完成终止处理后移除资源；结构性 owner 关系支持级联删除。

## Resource Printer

`ResourcePrinter<Spec, Status>` 按资源类型提供 `describe(resource): string` 和 `summarize(resource): string`，分别生成可读详情和简短概览。插件在激活阶段通过 `context.printers.register(...)` 注册；它与 Controller 独立，Resource 实例本身仍是可持久化的数据。

两个方法同步处理传入的资源快照，不修改资源、不查询外部系统、不调用模型。Host 通过 `Manager.describeResource(pluginInstanceId, resource)` / `summarizeResource(...)` 获取结果，返回 `Promise<string>`；Runner 沿用既有 handler IPC 与请求超时机制，只传输资源快照和文本，不重新查询资源。进程内插件同样使用快照副本，避免修改调用方持有的数据。

Printer 按插件实例和精确的 `apiVersion + kind` 选择，同一实例重复注册同一类型会失败。类型归属复用 ResourceRegistry，不能覆盖 Core 或其它插件的资源类型；注册失败整体回滚，实例关闭或 Runner 失效后撤销注册。没有专用 Printer 时，详情默认使用缩进 JSON，概览默认使用 `kind/name`。已注册 Printer 的执行失败记录资源身份和方法名，并向调用方返回错误。

这是 Resource 层的展示能力，不调整 Channel / Source / Harness 的接口，也不自动改变现有 Web 或 Harness 的展示。插件声明示例见 [Resource Printers](../../packages/plugin/README.md#resource-printers)。

## Source 与 Watch

运行机制中的 Source 负责初始发现和订阅，将观察到的资源交给 Host；CronSource 定期唤醒已有资源。Watch 将其它资源的变化映射为本 Controller 的 Reconcile 请求。它们负责触发，业务进展由 Reconcile 决定。

Personal 的“需求 Source”是一项业务能力：它用 RequirementSource 资源表达关注范围，借助 Controller 和定时再入队调用 Connector、比较观察并提交 Input。这个业务 Source 与框架的 Source 注册接口有联系，但不是同一个层级的概念，具体流程见 [Connector 与 Source](../connector/README.md)。

## Verb 与 Harness

Reconcile 通过 `ctx.verbs` 请求 say、ask、confirm、draft、harness，或通过 `connectors({ timeoutMs })` 调用外部系统。say 通过应用装配的持久消息出口保存普通 Message；Personal 将其保存在关联 Conversation 的 outbox，不建立 Interaction 或等待用户；成功表示持久化，投递由 Channel 负责。ask/confirm 保存 Interaction，draft/harness 按交互结果发起 HarnessInvocation；Connector verb 直接执行。插件只需表达意图、期限和目标，不处理提供方原生协议。

等待 verb 时释放 Controller 和 Runner 容量，同一资源的 Reconcile 仍保持串行。verb 的期限覆盖交互和执行全过程。拒绝确认是正常业务答案；取消、超时和失败需要插件自行决定业务结果。

`execution.withContext({ conversationId, inputId })` 将后续动作关联到业务会话和输入，主资源身份由 Core 提供。Channel 直接使用这些关联展示问题与执行进度，不通过 Chief 或 Harness Target 推导。其他组件按职责使用 Core 服务，不必经由 Verb。

Harness 返回执行结束不等于资源目标完成。结果校验、下一步安排、等待用户和业务终态都属于插件。

## Personal 实例

`plugins/personal/plugin.ts` 注册以下 Controller：

| Controller | 观察对象 | 业务职责 |
| --- | --- | --- |
| Chief 路由 | Host 内置 Input | 判断目标，更新 Conversation 资源 |
| Chief 会话 | Personal Conversation | 串行消费 Input，调用 Chief Harness，回复、询问或操作 Work |
| Requirement Source | RequirementSource | 按关注范围获取需求变化，提交 Input 并推进水位 |
| Task | Task | 推进有限目标，达到目标后结束 |
| Routine | Routine | 执行本轮，继续等待时间或事件 |

Task 与 Routine 分别归入 `plugins/personal/task/` 和 `plugins/personal/routine/`，各自保存模型与 Reconcile；公共字段和状态位于插件层的 `model.ts`，资源聚合与 Work 投影位于 `resources.ts`，公共执行辅助代码也留在插件层。Work 是它们的业务视图，没有另一份 Work 资源。Chief Agent 与工具在 `agents/chief/`，Personal 服务负责绑定会话范围和业务工具，应用入口负责安装插件并装配 Core。

添加新插件时复用 Resource / Reconcile / verb 机制，在插件内定义其领域模型。公共契约与示例见 [aide-plugin](../../packages/plugin/README.md)，Personal 的决策和生命周期见 [Personal](personal.md)。
