# Aide 的 Controller Runtime

Aide 底座是 TypeScript 的 controller-runtime：插件声明资源，Controller 根据变化读取当前状态，通过能力接口执行动作，再保存结果与下一次唤醒条件。Personal 是其上的个人助手插件，Input、Output、Person、Conversation、Task 和 Routine 都由 Personal 定义。

## 概念与所有权

| 概念 | 职责 |
| --- | --- |
| ResourceDefinition | 插件声明类型、Schema、校验、Printer 与保留策略 |
| ResourceClient / Storage | 统一身份、版本检查、事务、容量、引用与持久化 |
| Controller / Reconcile | 围绕一个资源实例推进领域状态 |
| Source / Watch | 发现资源，将变化映射为需要协调的资源身份 |
| ApplicationRuntime | 装配插件实例、调度、能力与执行记录 |
| Harness | 承接模型与工具执行，报告结果、事件和原生恢复身份 |
| Plugin | 定义领域模型、完成条件、恢复策略与对外行为 |

底座没有内置 Resource 类型，也不要求一次处理从用户消息开始。一个插件可以只观察外部资源，另一个插件可以调用 Harness 作判断；不使用 Personal 时仍能运行相同的存储、Watch 与 Reconcile 机制。Channel 如何接收消息、Input 如何归入 Conversation、Output 向谁投递，属于应用与业务插件。

资源按插件实例和 namespace 组织，业务身份不依附执行 Session。资源只有插件实例与 namespace 这一套作用域，ResourceDefinition 不再声明 shared/session，资源与引用不携带 sessionId。类型归属、Schema 与保留策略在 Controller 启动前注册，Runner 关闭后仍然有效。

## 一次协调如何推进

1. Source、API 或工具通过 ResourceClient 创建或更新资源。
2. 存储完成校验、版本检查、引用索引和容量检查，在提交后发布变更。
3. 主资源的创建、spec / metadata 变化和删除，或显式 Watch，映射为去重队列中的资源身份。
4. Reconcile 重新读取当前资源，决定直接调用外部能力、请求 Harness 判断，或等待。
5. Controller 保存结果和业务进展，必要时返回重新入队时间。

同一 Controller 对同一资源串行执行，不同资源可以并行。多个具名 Controller 可以观察同一种资源，它们拥有独立队列与定时记录，资源更新仍使用 CAS。纯 status 更新不自动唤醒主 Controller，避免写回状态造成忙循环；需要观察状态的协作方声明 Watch。

事件用于唤醒，持久资源承载进展。一次通知不等于一次独立业务操作；Controller 每次都应根据最新状态决定是否仍需要动作。

## 执行上下文

Operator 通过 `verbs.harness` 请求执行。运行时使用插件实例、资源类型、namespace、UID 与 Controller 名称定位上下文；同名资源删除后重建会获得新上下文。传输入口、Conversation 名字和一次 Reconcile 的执行 ID 都不能替代资源 UID。

HarnessTarget 表达具体执行配置，包含 ID、Harness 实现及模型等选项。Operator 可以从冻结快照的 `harnessTargets` 发现已配置目标，通过 harnessTargetId 选择；省略时使用应用默认目标。Target 是配置与能力发现信息，不要求注册为 Resource。原生 Session 仍由 Adapter 管理，恢复身份和 resumeState 由提供方协议决定。

业务可以用 `freshContext` 请求用当前提示材料建立新上下文。宿主同时记录历史边界，防止原生上下文重建时重新补入已被压缩或舍弃的材料。执行工作目录变化保留资源与执行记录，并清空原生恢复绑定。

执行结束只说明 Harness 收口。目标是否达成、是否需要核验、是否应当通知人，都由业务 Controller 判断。取消和超时也不能证明外部副作用没有发生。

### 执行后端的边界

ApplicationRuntime 直接组合插件 Manager 与 ExecutionService。前者管理插件、资源与调度，只通过 HarnessExecution 能力接口请求或取消调用；后者管理 Harness 执行、原生审批、存储租约与关闭。Manager 不读取执行历史，也不维护原生绑定。底座不再有 SessionStore / SessionHandle 或统一 ExecutionJournal 入口。

没有历史记录时，Harness 存储在首次调用时才创建；仅配置 Target、查询执行视图或运行资源 Controller 都不会创建执行存储。已有记录由 Harness 模块在启动时恢复。HarnessStore 保存调用事件、状态投影与原生绑定，EventLedger 是内部追加存储机制，不是插件运行的前置对象。

Reconcile 的冻结快照只有 cwd 与 HarnessTarget 配置，不复制全局执行历史。Harness 返回 invocationId 与执行结果；应用展示通过明确选择执行 ID 查询日志投影，取得副本。Personal 自己解释 Conversation/Input 关联，底座只保存不透明 attributes。

底座不再维护 Lane 或 Turn。资源执行上下文保存原生绑定与历史边界；HarnessInvocation 是一次调用的唯一执行身份，队列、事件、结果、取消与审批都关联 invocationId。同一资源上下文串行使用，不同上下文受并发上限约束，没有主通道或旁路通道。

Harness 记录继续沿用现有磁盘位置，旧路径名只属于存储兼容层。插件与调度的诊断日志写入应用根目录的 `runtime.log`。新事件使用 application scope，资源上下文与 invocationId 表达执行归属。读取兼容层将旧 Lane 坐标转换为 contextId，依据旧调用调度记录把 Turn ID 对应到 invocationId；新日志只写调用身份。转换保留事件序号、时间、原生 raw 数据和恢复水位，不修改提供方的原生会话文件。原生上下文重建仅补入当前资源上下文与 Target 的历史，跨资源知识由插件显式提供。

## 能力与事务

Reconcile 使用 Harness、Connector 和命名 action 请求能力。运行时管理调用身份、期限、取消和结果；具体 action 由应用装配，Personal 的 say 就是其中一个。底座不解释消息正文、收件人或输入消费。

`ResourceClient.commit` 用同一 SQLite 事务组合资源写入。校验、版本、引用或配额失败会全部回滚；Watch 只在提交后收到变化。插件可注入同步 admission 处理不可变事实和幂等回执，它仍处在同一事务中。外部请求不能加入资源事务，业务应区分“动作已发生”和“结果尚未提交”。Connector 调用在独立的 `connectors/calls.jsonl` 中保存发送意图与结果；重启将未完成调用记为 interrupted，不重放外部请求。旧执行文件中的未完成 Connector 调用会幂等迁移，原文件保留。

Host 容量管理按 Group/Kind 汇总。保留策略由资源所有者声明，只有已释放且无人引用的记录可以回收；没有规则的资源保持保护。配额压力不允许删除仍在承担工作的对象。

等待 Harness 或 Connector 时释放执行容量，同一资源的当前 Reconcile 调用栈仍保持独占。Runner 或 Host 中断后不会重放调用栈，未完成调用收口为失败或待核对；插件根据持久进展决定恢复动作。

## Host 与 Runner

Host 持有资源存储、Connector、Harness Adapter 和原生权限审批；Runner 运行插件回调、Source、Watch、队列、重试与定时唤醒。每个启用的插件实例有自己的 Runner，数量不随 Conversation 增加。进程内插件复用同一份资源与调度契约。

Host 与 Runner 不相互导入实现。双方通过 `src/protocol/` 协作，公共插件契约位于 `packages/plugin/`。PluginContext 只暴露运行环境、实例配置和能力入口；插件私有目录分为 package global 与 instance，不依附执行日志。

应用装配位于 `src/app.ts`。它安装 Personal、绑定 Channel 与 Connector、恢复业务资源，再启动 runtime。Personal 升级迁移在事务内保留 UID、版本、default 标记、待处理队列、定时记录与引用；执行日志的物理布局不决定这些业务事实的生命周期。

## Personal 的应用方式

Personal 将 Channel / Source 的内容保存为 Input，通过全局 Route 的规则直达或语义组批分发到 Conversation。Conversation 组织固定 Batch，Task / Routine 分别承载有限目标与持续职责，Person 保存身份与长期认识。业务状态与 Output 可以一起提交；投递器独立处理发送和回执，发送失败不重跑业务。

Route 与具名 Batch Controller 观察同一个 Personal Route 资源。前者管理队列和规则匹配，后者调用专用 Route Agent、保存分发计划并幂等投递；两者复用底座普通的资源、Watch、并发更新与 Harness 能力。

详见 [Plugin](plugin/README.md)、[Personal](plugin/personal.md)、[Harness](harness/README.md) 与 [Output](output.md)。`npm run check` 验证资源、调度、IPC、执行与恢复；真实提供方验收见 [E2E](e2e.md)。
