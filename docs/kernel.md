# Aide 的 Controller Runtime

Aide 底座是 TypeScript 的 controller-runtime：插件声明资源，Controller 根据变化读取当前状态，通过能力接口执行动作，再保存结果与下一次唤醒条件。单机是便于安装和使用的交付方式，资源协调模型不依附单机场景。未来服务端部署可由 Kubernetes CRD 承载资源；当前实现仍使用本地持久化。Personal 是其上的个人助手插件，Input、Output、Person、Conversation、Task 和 Routine 都由 Personal 定义。

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

Harness 配置在启动时装配，声明实现、模型与能力。Operator 从 snapshot.harnesses 发现配置，通过 harness 参数选择，省略时使用应用默认配置。Conversation 不动态注册配置；相同 Chief 配置下的原生会话由各调用方提供的 session 区分。

Operator 未传 session 时，新建原生上下文；传入 session 时复用或恢复该原生会话。摘要、材料与提示词由 Operator 准备，原生历史和恢复校验由 Harness 负责。

执行结束只说明 Harness 收口。目标是否达成、是否需要核验、是否应当通知人，都由业务 Controller 判断。取消和超时也不能证明外部副作用没有发生。

### 执行后端的边界

ApplicationRuntime 装配插件 Manager；配置 `harness` 时再装配 ExecutionService。纯资源插件无需 Harness 实现或占位执行配置。前者管理插件、资源与调度，只通过 HarnessExecution 能力接口请求或取消调用；后者管理 Harness 执行、原生审批、存储租约与关闭。Manager 不读取执行历史，也不维护原生绑定。底座不再有 SessionStore / SessionHandle 或统一 ExecutionJournal 入口。

Harness 自己保存原生会话、历史、压缩与 checkpoint，负责 durable 恢复。Aide 不保存执行事件日志、不在启动时回放调用、不从历史拼接恢复上下文。仅声明 Harness 配置、查询执行视图或运行纯资源 Controller 不会启动原生会话。

Plugin / Operator 通过 ResourceClient 操作 CRD，通过 Verb 发起非 CRD 操作。`harness` verb 将 create、resume、prompt、followUp、steer、abort、close 交给 Harness interface；没有 Binding 或额外 Agent interface。Host 记录调用关联、接收回执和结果，Harness 实现拥有运行句柄和原生协议。Verb 的统一诊断记录包含调用 ID、执行 ID、资源 UID、操作、耗时和结果，不复制模型上下文，也不承担恢复。

Operator 为服务重启保存必要的调用参数，例如 Personal 的 status.agent = { harness, sessionId? }。这些字段由 Operator 定义和读写；Harness verb 只接收参数、返回结果和已知恢复引用，不访问 ResourceClient，不约定 CRD 的 status 结构。持续 Route / Chief / Task 在 create 返回后先保存引用，再提交 prompt；保存失败不会重复 Harness 调用。没有独立的 Target 注册或 Context 会话目录。

Reconcile 的冻结快照只有 cwd 与 HarnessConfiguration 配置。Harness 返回 invocationId 与本次执行结果；应用按明确的执行 ID 查询实时投影副本。Personal 自己解释 Conversation/Input 关联，底座只传递不透明 attributes。同一资源上下文串行使用，不同上下文受并发上限约束。Followup 复用原生会话，steer 在原生能力支持时追加立即输入。

`HarnessActivity` 只承载进程内的调用、审批与 Web 展示；保留活跃调用和最近 40 次已结束调用，空闲上下文缓存也保留最近 40 个。淘汰空闲句柄不删除 Harness 自己保存的会话。重启后实时执行细节消失，Input、Output 和处理进展仍由业务资源恢复。原生恢复失败明确报错，不静默创建新会话或重放可能产生副作用的操作。

应用根目录的 `runtime.log` 保存插件与调度诊断，`harness-runtime.log` 和轮转的 `harness-native.jsonl` 保存执行及协议诊断，均不用于恢复。资源数据库以插件实例为 scope，键由实例、namespace、类型和名称组成。移除的执行存储没有迁移、兼容或双读路径。

## 能力与事务

Reconcile 使用 Harness、Connector 和命名 action 请求能力。运行时管理调用身份、期限、取消和结果；具体 action 由应用装配，Personal 的 say 就是其中一个。底座不解释消息正文、收件人或输入消费。

`ResourceClient.commit` 用同一 SQLite 事务组合资源写入。校验、版本、引用或配额失败会全部回滚；Watch 只在提交后收到变化。插件可注入同步 admission 处理不可变事实和幂等回执，它仍处在同一事务中。外部请求不能加入资源事务，业务应区分“动作已发生”和“结果尚未提交”。Connector 调用在独立的 `connectors/calls.jsonl` 中保存发送意图与结果；重启将未完成调用记为 interrupted，不重放外部请求。

Host 容量管理按 Group/Kind 汇总。保留策略由资源所有者声明，只有已释放且无人引用的记录可以回收；没有规则的资源保持保护。配额压力不允许删除仍在承担工作的对象。

等待 Harness 或 Connector 时释放执行容量，同一资源的当前 Reconcile 调用栈仍保持独占。Runner 或 Host 中断后不会重放调用栈，未完成调用收口为失败或待核对；插件根据持久进展决定恢复动作。

## Host 与 Runner

Host 持有资源存储、Connector、Harness Adapter 和原生权限审批；Runner 运行插件回调、Source、Watch、队列、重试与定时唤醒。每个启用的插件实例有自己的 Runner，数量不随 Conversation 增加。进程内插件复用同一份资源与调度契约。

Host 与 Runner 不相互导入实现。双方通过 `src/protocol/` 协作，公共插件契约位于 `packages/plugin/`。PluginContext 只暴露运行环境、实例配置和能力入口；插件私有目录分为 package global 与 instance，不依附执行日志。

应用装配位于 `src/app.ts`。它安装 Personal、绑定 Channel 与 Connector、恢复业务资源，再启动 runtime。当前格式的资源在重启后保留 UID、版本、default 标记、待处理队列、定时记录与引用；执行日志的物理布局不决定这些业务事实的生命周期。

## Personal 的应用方式

Personal 将 Channel / Source 的内容保存为 Input，通过全局 Route 的规则直达或连续语义分类分发到 Conversation。Input.status 记录 route / assess / handle；Conversation 通过索引读取自己的未完成研判，驱动持久上下文的 Chief loop，Task / Routine 分别承载有限目标与持续职责，Person 保存身份与长期认识。业务状态与 Output 可以一起提交；投递器独立处理发送和回执，发送失败不重跑业务。

Route 与具名 agent Controller 观察同一个 Personal Route 资源。前者管理队列和规则匹配，后者调用专用 Route Agent、保存分发计划并幂等投递；两者复用底座普通的资源、Watch、并发更新与 Harness 能力。

详见 [Plugin](plugin/README.md)、[Personal](plugin/personal.md)、[Harness](harness/README.md) 与 [Output](output.md)。`npm run check` 验证资源、调度、IPC、执行与恢复；真实提供方验收见 [E2E](e2e.md)。
