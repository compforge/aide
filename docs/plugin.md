# Plugin 运行机制

Plugin 是业务扩展的组织与所有权单位。插件声明资源和回调，Host 提供持久化、调度、Harness 与交互能力。Personal 是 Aide 的一个内置 Plugin，负责个人助手的业务判断；通用运行机制可以承载其它插件。

## Package、Instance 与 Runner

`PluginPackage` 通过 `activate(context)` 注册 Resource Controller、Source、Watch、Hook、Command 等能力。Package 描述插件代码，一份启用配置对应一个 PluginInstance；Host 为实例建立 Binding 并启动独立 Runner，加载插件后完成注册。

Host 的 Supervisor 管理 Runner 和 IPC，Runner 只执行插件回调。资源存储、队列和执行事实留在 Host。PluginContext 将资源操作和 verb 转成跨进程请求，插件无需引用宿主 Store 或 Harness SDK。

实例关闭或 Runner 失败时，Host 撤销注册并终止未完成调用。Runner 不自动重启；重新启动 Aide 会重新激活插件。回调中的内存状态与异步调用栈不会跨重启恢复。

## Resource 与 Reconcile

Resource 用类型、namespace、name 和 uid 表达身份，spec 保存目标，status 保存插件的业务进展。一个 Controller 拥有一种资源类型的 Reconcile：每次读取当前事实，推进目标，再持久化结果或安排下次唤醒。

资源变化、Source、Watch、cron 和 `requeueAfterMs` 共用按资源身份去重的队列。同一资源串行处理；不同资源受 Controller 与 Manager 的容量约束。基础设施回调重试不保证外部操作只发生一次，插件须保存已进入执行的状态，避免把重试变成业务重放。

资源写入使用版本检查。跨越 Harness 或用户等待后，应按 uid 重新读取资源，避免旧回调更新同名替代资源。删除先持久化 deletionTimestamp，Controller 完成终止处理后移除资源；结构性 owner 关系支持级联删除。

## Source 与 Watch

运行机制中的 Source 负责初始发现和订阅，将观察到的资源交给 Host；CronSource 定期唤醒已有资源。Watch 将其它资源的变化映射为本 Controller 的 Reconcile 请求。它们负责触发，业务进展由 Reconcile 决定。

Personal 的“需求 Source”是一项业务能力：它用 RequirementSource 资源表达关注范围，借助 Controller 和定时再入队调用 Connector、比较观察并提交 Input。这个业务 Source 与框架的 Source 注册接口有联系，但不是同一个层级的概念，具体流程见 [Connector 与 Source](connectors.md)。

## Verb 与 Harness

Reconcile 通过 `ctx.verbs` 请求 ask、confirm、draft 或 harness。Host 保存 Interaction，按结果发起 HarnessInvocation，再把执行结果经 IPC 返回。插件只需表达意图、期限和目标，不处理提供方原生协议。

等待 verb 时释放 Controller 和 Manager 容量，同一资源的 Reconcile 仍保持串行。verb 的期限覆盖交互和执行全过程。拒绝确认是正常业务答案；取消、超时和失败需要插件自行决定业务结果。

Harness 返回执行结束不等于资源目标完成。结果校验、下一步安排、等待用户和业务终态都属于插件。

## Personal 实例

`plugins/personal/plugin.ts` 注册以下 Controller：

| Controller | 观察对象 | 业务职责 |
| --- | --- | --- |
| Chief | Host 内置 Conversation 投影 | 串行消费 Input，调用 Chief Harness，回复、询问或操作 Work |
| Requirement Source | RequirementSource | 按关注范围获取需求变化，提交 Input 并推进水位 |
| Task | Task | 推进有限目标，达到目标后结束 |
| Routine | Routine | 执行本轮，继续等待时间或事件 |

Task 与 Routine 的公共执行辅助代码留在 Personal 内部。Work 是它们的业务视图，没有另一份 Work 资源。Chief Agent 与工具在 `agents/chief/`，宿主端 Personal 装配负责绑定会话范围和数据服务。

添加新插件时复用 Resource / Reconcile / verb 机制，在插件内定义其领域模型。公共契约与示例见 [aide-plugin](../packages/plugin/README.md)，Personal 的决策和生命周期见 [Personal](personal.md)。
