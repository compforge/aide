# Aide 的 Controller Runtime

Aide 底座是 TypeScript 的 controller-runtime：插件声明资源，Controller 根据变化读取当前状态，通过能力接口执行动作，再保存结果与下一次唤醒条件。Personal 在其上实现个人助手；单机是交付方式，资源协调模型可以由未来的 Kubernetes CRD 后端承载，当前使用本地持久化。

## 概念与所有权

| 概念 | 职责 |
| --- | --- |
| ResourceDefinition | 插件声明类型、Schema、校验、Printer、索引与保留策略 |
| ResourceClient / Storage | 统一身份、版本、事务、引用、容量与持久化 |
| Controller / Reconcile | 围绕一个资源实例推进领域状态 |
| Source / Watch | 发现资源，将变化映射为协调请求 |
| ApplicationRuntime | 装配插件实例、调度、Connector 与可选执行能力 |
| Harness | 承接模型和工具执行，拥有原生历史与可恢复会话 |
| Plugin | 拥有领域模型、完成条件、恢复策略与对外行为 |

业务资源属于插件实例与 namespace，身份不依附执行 Session。底座不预注册 Input、Output 或 Conversation；一个插件可以只观察和协调资源，另一个插件可以通过 Harness 请求判断。应用负责装配通信入口和投递能力。

## 一次协调如何推进

1. Source、API 或工具通过 ResourceClient 创建或更新资源。
2. 存储在事务中完成校验、版本、索引和容量检查，提交后发布变化。
3. 主资源变化或显式 Watch 映射为去重队列中的资源身份。
4. Reconcile 读取最新状态，决定直接请求外部能力、调用 Harness，或等待。
5. 业务组件保存进展和回执，必要时返回下次唤醒时间。

同一 Controller 对同一资源串行，不同资源可以并行。多个具名 Controller 可以观察同一种资源，有各自的队列和定时记录，共享写入仍使用 CAS。纯 status 更新不自动唤醒主 Controller，协作方按需声明 Watch。事件用于唤醒，持久资源承载事实。

## Host 与 Runner

Host 持有资源存储、Connector、Harness Adapter 和原生权限审批；Runner 运行插件回调、Source、Watch、队列、重试和 Reconcile。每个启用插件实例有自己的 Runner，数量不随 Conversation 增加；进程内插件使用相同契约。

双方通过 src/protocol 协作，不互相导入实现。公共契约位于 packages/plugin。资源定义在恢复和 Controller 启动前加载，校验、打印与容量规则不依赖 Runner 存活。插件私有目录按 package global 与 instance 组织。

## 执行后端的边界

ApplicationRuntime 始终提供资源协调，按需装配 ExecutionService。Manager 通过 HarnessExecution 能力请求执行，不读取原生历史。Operator 经 harness verb 操作 Harness interface，传入配置名与可选原生 sessionId；接口契约见 [Harness](harness/README.md)。

运行时用插件实例、资源 UID 与 Controller 定位调用范围，删除后同名重建获得新的范围。Operator 自己保存恢复参数，例如 Personal 的 status.agent；Harness verb 不访问资源，也不约定 status 结构。持久会话、压缩与恢复由 Harness 负责，服务重启不会回放 Aide 的调用栈。

HarnessActivity 提供有界进程内执行投影；诊断日志用于排查，不参与恢复。执行结束只说明调用收口，目标达成、输入确认与通知送达由业务组件分别判断。取消或超时不能证明外部副作用没有发生。

## 能力与事务

Plugin / Operator 通过 ResourceClient 操作 CRD，通过 Verb 发起非 CRD 操作。运行时管理调用关联、期限、取消和诊断；业务元数据以不透明 attributes 传递，只有所属插件解释其含义。

资源事务可组合业务状态与回执，不能覆盖外部请求。外部动作与结果落盘之间中断时，插件应核对已有副作用。Connector 自持调用记录，未完成调用在重启后记为 interrupted，不重放外部请求。

资源所有者声明能否释放，Host 执行容量限制与合格对象的淘汰排序。未完成的工作不能仅因 LRU 而被删除。事务、引用和容量的具体契约见 [Resource](plugin/resource.md)。

等待 Harness 或 Connector 时释放执行容量，当前 Reconcile 的同资源串行约束仍保留。插件根据持久事实恢复，不能依赖进程内队列或异步调用栈跨重启存在。

## 应用方式

[Personal](personal/README.md) 将 Channel / Source 的内容保存为 Input，经 Route 归入 Conversation，由 Chief 研判并按需交给 Task / Routine。Input.status 保存 route / assess / handle 痕迹；Output 独立记录表达与投递；Person 保存身份和认识。

应用装配在 src/app.ts 完成。配置在启动时解析，详见 [配置](configuration.md)；运行目录、备份和诊断见 [部署](deployment.md)，真实依赖验收见 [E2E](e2e.md)。
