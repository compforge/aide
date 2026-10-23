# Plugin 运行机制

Plugin 是领域模型与业务判断的所有者。Package 声明纯资源定义，activate 注册 Controller、Source、Watch 与 Hook；一份启用配置形成一个 PluginInstance，由 Host 装配独立 Runner。

## Host 与 Runner

Host 持有 Resource 存储、Connector 和可选 Harness 执行能力；Runner 运行插件回调、观察、队列、重试和 Reconcile。双方通过协议通信，不相互导入实现。PluginContext 将资源、Connector 和 verb 操作转为宿主请求。

实例关闭或 Runner 失败时撤销运行能力并终止未完成调用；资源定义随 Host 保留。Runner 不自动重启，重启 Aide 会重新激活插件。内存状态与异步调用栈不跨进程恢复，插件依据持久业务进展决定下一步。

插件私有目录分为 package global 与 instance，见 [部署状态目录](../deployment.md#状态目录)。纯资源插件无需配置 Harness。

## Resource 与协调

资源身份由插件实例、类型、namespace、name 与 UID 表达。spec 保存目标，status 保存进展；定义、事务、Printer、索引与容量见 [Resource](resource.md)。每种 CRD 在 plugin package 下有自己的目录，模型、Reconcile 和专属辅助代码就近组织；跨资源协作留在插件层。

资源变化、Source、Watch、cron 和 requeueAfterMs 共用去重队列。同一 Controller 对同一资源串行，不同资源受 Controller 与 Runner 容量约束；具名 Controller 有独立的队列、锁和定时记录，共享资源更新仍需版本检查。

事件用于唤醒，Reconcile 每次读取当前事实决定是否行动。主资源的纯 status 更新不自动唤醒自身，需感知该变化的协作方显式声明 Watch。回调重试不保证外部副作用只发生一次，插件应保存接纳状态与完成凭据。

## Source 与 Watch

框架 Source 负责发现和订阅资源，Watch 把其它资源变化映射为协调请求，CronSource 定期唤醒已有资源。这些机制提供触发，业务 Controller 决定如何推进。

Personal 的业务 Source 则用资源保存观察范围、水位和待提交计划，经 Connector 获取事实并形成 Input。两个层次的 Source 分别承担框架触发与领域观察，具体接入见 [Connector 与 Source](../connector/README.md)。

## Verb 与外部能力

Plugin / Operator 通过 ResourceClient 操作 CRD，通过 Verb 发起非 CRD 操作。harness verb 封装 [Harness interface](../harness/README.md)，命名 action 由应用装配；Connector 提供类型化外部访问。verb 诊断记录关联身份、操作、耗时和结果，不复制敏感参数与原生历史。

等待 verb 时释放 Controller / Runner 执行容量，同一资源的当前 Reconcile 调用栈仍保持串行。期限覆盖等待与执行，取消和失败后的业务含义由插件决定。

execution.withContext 为动作附加不透明 attributes；主资源身份由运行时提供，业务关联由插件解释。Harness verb 只接收配置和原生会话参数，不读写 CRD；调用者决定如何保存恢复引用。原生接收回执、工具业务回执和外部送达分别确认。

完整公开契约与注册示例见 [aide-plugin](../../packages/plugin/README.md)。[Personal](../personal/README.md) 是这些机制的内置使用者。
