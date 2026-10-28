# Resource：声明、事务与生命周期

资源所有者定义目标与释放条件，Host 统一校验、持久化、查询和执行容量策略。

## 定义与校验

Resource 用类型、namespace、name 和 uid 表达身份，spec 保存目标，status 保存插件的业务进展。 `ResourceDefinition` 统一声明 type、spec/status schema、可选 validator、printer、indexes 和 retention。Host 在恢复资源、启动 Controller 前加载声明；未知类型不能写入。进程内插件通过 resources 提供声明，独立 Runner 的 PackageEntry 通过 resourcesUrl 指向默认导出定义数组的纯模块，Host 直接加载它。声明模块不导入 Runner 或 Host 实现，不执行 I/O。

资源统一属于插件实例与 namespace，资源和调度身份不携带 sessionId。底座不预注册任何业务资源。每种资源可以没有 Controller，也可以由多个具名 Controller 观察。

所有创建、更新和删除请求都在存储事务内经过 Schema 与 Validator，包括 Agent 工具、Source 与 commit。Schema 的规范化输出作为持久数据；Validator 可读取同一作用域内的事务快照，包含当前 commit 已完成的前序写入。它不能执行异步工作或外部副作用。校验、引用计算或配额失败会回滚整笔写入。

## API 版本与演进

apiVersion 表达资源结构与语义契约，metadata.generation 表达 spec 修订，metadata.resourceVersion 用于并发控制；产品 VERSION 与它们独立。

不兼容的结构或语义调整必须升级受影响 Kind 的 apiVersion，例如 v1alpha1 → v1alpha2。兼容性新增可留在原版本；已有 Condition 含义的改变同样属于契约变更。升版需要同步 Schema、类型声明、引用与消费入口。

当前开发阶段旧版本先不处理：不实现转换、迁移、双读或字段回退，也不自动删除旧记录。存储与查询按 apiVersion 区分，修改版本号不会使旧记录自动变成新版本。未来确需保留旧数据时再单独建设版本转换能力。

Personal 的共享状态片段、Conditions 与对象独有状态的更新方案见 [资源状态与组件协作](../status.md)。

## 事务与删除

ResourceClient.commit 在同一插件实例的存储事务中组合 create、replace、patchStatus 和 delete。delete 携带资源快照，校验 UID 与 resourceVersion 后提交级联删除请求，最终移除仍走标准 Reconcile / finalize 生命周期。Schema、版本、引用、索引或配额失败会回滚，Watch 只在提交后收到通知。事务可提交资源与幂等回执，但不能包含外部请求；外部动作成功后的写入冲突不能靠重做动作解决。

资源引用使用精确 UID；跨外部能力等待后应重新读取，避免更新同名替代资源。删除先写 deletionTimestamp，再由 Controller 完成终止处理和 finalize；结构性 owner 关系支持级联删除。

## 索引

Definition.indexes 声明纯函数 `(resource) => string[]`，可为一个字段产生多个索引值。`resources.list(type, { matchIndex: { name, value } })` 查询精确匹配，并保留插件实例、类型及 namespace 隔离。Host 将索引与资源写入同一事务，删除时级联移除，加载定义时重建；未知索引报错，不回退全表扫描。回调不得执行 I/O 或业务动作。

## Resource 容量与释放

Host 的 `ResourceStorage` 将所有插件 Resource 存入共享 SQLite，以按需读取替代常驻完整快照集合。容量按 Group/Kind 汇总，配额覆盖不同 API 版本、namespace 和插件实例；同时限制单条大小、每种数量/字节以及 Host 总字节。配置见 [Resource 容量](../configuration.md#resource-容量)。

资源所有者通过 `ResourceDefinition.retention` 定义释放时间和引用的精确 uid，与类型一起注册。没有释放时间的资源保持保护；排序策略只决定合格记录的回收次序。声明中的 owner 也进入引用索引，正在删除的资源交由原有删除流程完成。业务资源的释放条件由所属插件说明。未知 kind 同样参与配额，未声明释放规则时不会自动删除。

每次写入在事务内同步记录、引用索引、回执和必要的回收。无法满足容量约束时整个事务回滚，变更通知只在提交后发出。因此过载会阻止接收更多工作，不会通过删除正在承担的工作来腾空间。完成并缩小记录的更新允许在超配额状态下提交。

原生历史与 checkpoint 由 Harness 管理；Operator 可在资源 status.agent 保存下次调用所需的配置名和会话引用，引用计入资源配额。Harness verb 不读写这些字段。Resource 配额不等于进程 RSS 或全部磁盘文件的硬上限。

## Resource Printer

`ResourcePrinter<Spec, Status>` 按资源类型提供 `describe(resource): string` 和 `summarize(resource): string`，分别生成可读详情和简短概览。它声明在 `ResourceDefinition.printer` 中，与 Controller 独立，Resource 实例本身仍是可持久化的数据。

两个方法同步处理传入的资源快照，不修改资源、不查询外部系统、不调用模型。拿到 Resource 后，插件通过 `await context.printers.describe(resource)` / `summarize(resource)` 获取文本，无需知道具体 Printer。Host 使用 `Manager.describeResource(pluginInstanceId, resource)` / `summarizeResource(...)`，同样返回 `Promise<string>`；Runner 通过 IPC 请求 Host 打印，只传输资源快照和文本；Printer 在 Host 同步执行，始终收到快照副本，不重新查询资源。

Printer 按插件实例与 GVK 选择，同一实例不能重复声明同一类型。类型归属由 ResourceRegistry 维护，不能覆盖其它插件的资源类型；声明失败整体回滚，实例关闭或 Runner 失效不撤销定义。没有专用 Printer 时，详情默认使用缩进 JSON，概览默认使用 `kind/name`。已注册 Printer 的执行失败记录资源身份和方法名，并向调用方返回错误。

公开接口与示例见 [aide-plugin](../../packages/plugin/README.md)，Input / Output 的具体保留与打印规则见 [Personal](../personal/README.md)。
