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

## Spec、Status 与写入责任

spec 表达期望或输入契约，status 表达组件已观察到的事实。各 Kind 声明字段含义、写入者及允许写入的阶段；多个组件协作时按字段分工，UID 固定资源身份，写入条件表达操作依赖，保留其它组件负责的状态。更新操作按依赖选择局部 Patch、条件 Patch 或显式 CAS，见下节。事件用于唤醒，恢复与协调依赖持久事实。

status 按对象需要组合三类内容：

| 内容 | 用途 | 示例 |
| --- | --- | --- |
| 具体事实与回执 | 保存当前关系、结果与恢复依据 | 资源引用、接纳和完成回执 |
| conditions | 提供稳定的状态判断 | 目标是否达成、是否需要介入 |
| 调谐进度 | 支持等待、重试与重启后继续 | 已观察版本、重试时间、检查进度 |

详细执行轨迹独立保存，status 不无限追加模型调用、工具输出和每次 Reconcile 日志。防止重复办理所需的接纳与完成回执属于业务事实，不降级为可能丢失的诊断事件。共享片段由对象按语义组合，不要求所有 Kind 继承包含大量可选字段的 BaseStatus。

## 更新操作与并发

ResourceClient、Host/Runner 协议与 Storage 共同提供以下更新语义。不同组件可并行修改同一 Resource 的不同字段；整份资源版本只在明确依赖完整快照时作为前置条件。

| 操作 | Aide 契约 | Kubernetes 对应 |
| --- | --- | --- |
| replace | 校验 UID 和快照 resourceVersion，整体替换 spec/status | Update 的乐观锁 |
| patch，type=merge | 将 JSON Merge Patch 应用到事务内最新对象；不隐含快照版本条件 | JSON Merge Patch；MergeFrom 默认不锁版本 |
| patch，type=json | RFC 6902 test 与修改在一个事务内执行 | JSON Patch |
| patch 的 options.resourceVersion | 显式启用整份资源乐观锁 | MergeFromWithOptimisticLock |
| patchStatus | 仅对 status 应用 Merge Patch；同样接受显式 resourceVersion | status 子资源的局部更新 |
| patchMetadata | 仅合并 labels/annotations；不隐含快照版本条件 | 元数据局部 Patch |

Merge Patch 递归合并对象，整体替换数组，null 删除字段。`{}` 不清空已有对象，省略字段也不删除旧值。需要保存 JSON null 或整体替换一个 map 时使用 JSON Patch 的 add/replace。每种 Resource 的 Schema 仍可提供默认值；无效结构拒绝写入。

```ts
// 调度字段已变化也不会阻塞这项独立赋值。
await resources.patchStatus(snapshot, { progress: "observed" });
// 依赖旧内容的编辑明确声明条件。
await resources.patch(snapshot, { type: "json", value: [
  { op: "test", path: "/status/summary", value: snapshot.status.summary },
  { op: "replace", path: "/status/summary", value: revisedSummary },
] });
// 状态转移若依赖完整快照，显式锁版本。
await resources.patchStatus(snapshot, { phase: "accepted" }, {
  resourceVersion: snapshot.metadata.resourceVersion,
});
```

普通 Patch 仍校验 UID，不能用旧句柄修改重建后的同名资源。可写路径仅限 spec、status、metadata.labels 和 metadata.annotations；身份、版本、结构 owner、删除标记和 Host 调度字段不可修改。`patchStatus` 无法越过 status 范围。已进入删除阶段的资源由领域 Validator 决定哪些终止写入仍允许，内容工具拒绝继续编辑。

Storage 在 SQLite 写事务内读取当前对象，在副本上应用 Patch，验证元数据、Schema 和领域约束，再提交版本、索引与容量变化。spec 实际变化推进 generation；有效变更推进 resourceVersion；规范化后的空操作不增加版本、不发送 Watch。Watch 的前后对象来自真实事务快照。commit 可混合普通与条件 Patch，任何一步失败全部回滚；IPC 使用相同路径和错误名称。

显式版本冲突的 Error.name 是 ResourceVersionConflict，UID 变化是 ResourceIncarnationChanged；JSON test 失败保留 TEST_OPERATION_FAILED。Schema/Validator 错误原样返回。IPC 保留 name、message、stack、cause；跨进程根据 name 分类，不依赖 instanceof。条件失败需要重新读取实际依赖，不能盲目重放失败 test 或重做已发生的外部动作。

### 字段、集合与领域依赖

调用方只提交实际变化。条件数组不是自动按 type 合并的 map：Personal 的状态转换辅助函数计算 JSON 差异、显式携带整份快照 CAS，保证事实和派生条件一致，冲突后由代码重新协调；不会展开旧 status 提交，也不会覆盖其它组件的条件。内容工具走独立条件 Patch，校验旧内容；执行身份和当前祖先链由插件 Validator 在事务内读取。底座不认识 summary、Note 或 Chief。

Aide 对齐 [Kubernetes 更新语义](https://kubernetes.io/docs/reference/using-api/api-concepts/#updates-to-existing-resources) 和 [controller-runtime 的显式乐观锁](https://pkg.go.dev/sigs.k8s.io/controller-runtime/pkg/client#MergeFromWithOptimisticLock)。本轮提供 JSON Merge Patch / JSON Patch，不提供 Strategic Merge Patch、Server-Side Apply 或 managedFields。多资源 commit 与跨资源 Validator 是 Aide 的本地事务扩展，不能视为 Kubernetes 的跨对象事务。

验证覆盖普通并发合并、条件失败、原子回滚、UID 替换、元数据校验、无变化通知及真实 Runner IPC，见 tests/resource-patch.test.ts、tests/plugin-runner.test.ts。Personal 的内容与独立 Note 契约见 [Note](../personal/note.md)。

## Conditions 契约

需要稳定状态判断的 Kind 可声明 conditions。集合按 type 唯一，每种条件有明确的维护者和业务含义；Host 不要求所有资源具有 conditions，也不将所有条件取 AND 作为通用 Ready。

| 字段 | 契约 |
| --- | --- |
| type | 稳定的业务判断名称，含义属于 API 契约 |
| status | True、False 或 Unknown；缺失条件表示尚无判断，不能推断为成功 |
| reason / message | reason 是稳定机器分类，message 说明当前依据或问题 |
| lastTransitionTime | 仅在 status 改变时更新；reason、message 或观察版本变化不刷新它 |
| observedGeneration | 判断依据 spec 时记录对应的 metadata.generation |

当前实现中，组件在提交前合并自己负责的条件与具体事实，保留其它条件，通过 ResourceClient 的版本校验和事务一起提交；局部条件更新的演进遵循上面的更新契约。Host 校验并持久化调用方提供的状态，不推断业务条件，不设置通用派生钩子。发生冲突时重新读取、重新判断并提交；已发生的外部动作不能为重试写入而重复执行。

跨资源的判断保存依赖版本，由 Watch 与 Reconcile 重算；自身 observedGeneration 无法代表外部依赖的新旧。消费者按契约识别过期结论，不能将旧 True 当作对新状态的保证。Conditions 补充具体事实，不代替幂等、并发控制或安全交接，也不自动解决数据兼容。

这与 Kubernetes 的领域边界一致：条件由所属组件构造，存储不推导其业务含义。但更新语义必须区分普通差异 Patch 与显式 MergeFromWithOptimisticLock，不能将 resourceVersion 检查当成所有 Status().Patch 的默认行为。跨对象判断是带依赖依据的最终一致观察，不承诺全局同时更新。

## 事务与删除

ResourceClient.commit 在同一插件实例的存储事务中组合 create、replace、patch、patchStatus 和 delete。delete 携带资源快照，校验 UID 与 resourceVersion 后提交级联删除请求，最终移除仍走标准 Reconcile / finalize 生命周期。Schema、版本、引用、索引或配额失败会回滚，Watch 只在提交后收到通知。事务可提交资源与幂等回执，但不能包含外部请求；外部动作成功后的写入冲突不能靠重做动作解决。

单次 commit 上限为 100 个写操作，业务不能通过对整棵树空写来把无界依赖集变成写集。Definition Validator 的 `context.get(type, uid)` 和 `context.list(type, { namespace, matchIndex })` 在当前存储事务中同步读取依赖，保留插件实例与精确 apiVersion/kind 隔离，读取结果是独立快照；list 未指定 namespace 时覆盖本插件该类型的全部 namespace。前序写入和索引变更对后续校验可见，校验失败整体回滚。Host 提供读取与事务机制，祖先链、责任归属和在途工作等业务约束由插件声明。

资源引用使用精确 UID；跨外部能力等待后应重新读取，避免更新同名替代资源。删除先写 deletionTimestamp，再由 Controller 完成终止处理和 finalize；结构性 owner 关系支持级联删除。

## 索引

Definition.indexes 声明纯函数 `(resource) => string[]`，可为一个字段产生多个索引值。`resources.list(type, { matchIndex: { name, value } })` 查询精确匹配，并保留插件实例、类型及 namespace 隔离。Host 将索引与资源写入同一事务，删除时级联移除，加载定义时重建；未知索引报错，不回退全表扫描。回调不得执行 I/O 或业务动作。

## 分页查询

ResourceReader.listPage(type, options) 提供有界读取，Host 与 Runner 使用同一契约。options 复用 namespace、includeDescendants、matchLabels 和 matchIndex，consistency 默认为 consistent，可显式选 live；并要求 limit 为 1..1000 的整数；continue 为上一页返回的不透明游标。返回形态为 `{ items, metadata: { resourceVersion, continue } }`，continue 为空字符串表示结束。现有 list 返回完整数组；需要限制读取的路径显式使用 listPage，不能先 list 再 slice。

```ts
const query = { namespace: "v1" as const, matchIndex: { name: "topic", value: topicUid }, limit: 41 };
const first = await resources.listPage(INPUT_TYPE, query);
// 若索引已准确表达待判断集合，41 条足以判断是否超过 40 条；无需精确 count。
if (first.metadata.continue) {
  const next = await resources.listPage(INPUT_TYPE, { ...query, continue: first.metadata.continue });
}
```

页面按 metadata.namespace、metadata.name 的 UTF-8 二进制顺序排列，不依赖系统 locale。namespace 默认 v1，includeDescendants 只匹配路径边界内的后代；类型按完整 apiVersion/kind 隔离，查询始终受插件实例限制。标签为 AND 精确匹配，索引须已由 ResourceDefinition 注册。分页不隐含删除过滤，deletionTimestamp 对象仍可列出；需要业务过滤时由领域声明相应索引。

游标绑定插件、资源类型、namespace 范围和规范化后的 selectors；limit 可以在下一页调整。过滤条件不匹配或游标格式错误返回 ResourceContinueInvalid。consistent 模式下，游标签名不可验证（包括 Host 重启）或集合修订变化返回 ResourceExpired；调用方须丢弃已收集的分页结果，从第一页重读。错误名称经过 IPC 保留，日志只记录 namespace、limit 和是否续页，不记录正文、selector 值或游标。

collection resourceVersion 属于同一插件和精确 apiVersion/kind 的整个集合，不是某个对象的 resourceVersion，不能用于对象 CAS。创建、对象内容更新、删除请求、最终删除、容量淘汰和索引重建会推进集合修订；其它 namespace 内同类型对象的变化也会使游标过期。其它插件/类型的写入、无变化 Patch、调度 control 和 LRU 访问时间不会使游标过期。修订与资源写入同事务提交，失败回滚不会失效。

这与 Kubernetes 的 limit/continue 及 ResourceExpired 恢复方式对齐，但不提供 API Server 保留历史快照的能力：Aide 在集合未变化时继续同一修订，一旦变化就明确过期。游标不跨 Host 重启保存，也不持有长事务、无界快照缓存或整个资源列表。活跃集合可能反复过期，调用方应由后续 Reconcile 重试，不能无界热循环。

SQLite 执行 namespace/selector 过滤、稳定排序、keyset 续页和 LIMIT；先取至多 limit+1 个 key，再在同一事务内读取至多 limit 个完整对象。无索引条件时使用 scope/type/namespace/name 表达式索引；有 matchIndex 时使用 resource_page_lookup 覆盖索引，按插件、类型、索引名和值、namespace/name 有序定位资源键；没有标签附加过滤时，无需逐个读取匹配对象的 JSON 或建立临时排序表。索引投影与资源索引同事务维护，已有索引在首次安装时原子回填。不存在 includeDescendants 的全资源枚举。标签等附加过滤仍可能检查超过 limit 个候选，因此不承诺任意 selector 的 SQLite 工作量为 O(limit)。常用 namespace + matchIndex 查询通过有序范围查找限制候选读取；查询计划测试直接捕获生产 SQL，包含实际 ORDER BY 和续页条件。不增加公共 Count/Exists 或业务排序；存在性可用 limit=1，阈值判断可用 limit=阈值+1。

验证见 tests/resource-pagination.test.ts（隔离、页边界、读取预算、查询计划、过期与回滚）和 tests/plugin-runner.test.ts（真实 Runner 分页与错误跨进程）。

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

### 持续变化集合的遍历

`listPage(type, { ...selectors, limit, consistency: "live", continue })` 用于后台协调。首批记录当前最大 namespace/name，后续按 `(上次键, 初始上界]` 前进，返回每页读取时的最新对象；collection resourceVersion 仅描述该页观察值。状态更新、索引变更、删除和自身写入不使游标过期，签名密钥持久保存在同一个资源数据库中，重启可继续；游标仍绑定插件、类型、selectors 和模式。

live 不保证快照、恰好一次或枚举所有并发新增对象：游标之前插入或移入的对象、上界之后新增对象由后续协调处理，同名重建也必须按 UID 验证。消费者持久化检查点前先完成该页幂等动作，失败可重复该页，执行业务动作时重新核验身份和真实依赖。上下界防止已有游标无止境追逐尾部新增；持续在剩余区间插入仍不承诺固定总工作量。该模式是 Aide 的可恢复遍历扩展，不等同于 Kubernetes 保留历史快照的 limit/continue。

验证见 `tests/resource-pagination.test.ts`：默认一致性、live 自身写入/删除/重启、上界、选择器绑定及生产 SQL 的覆盖索引查询计划。
