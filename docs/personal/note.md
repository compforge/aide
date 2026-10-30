# Note

披露权限与实际投递见 [披露边界](disclosure.md)：材料使用 sensitivity/visibility，人物使用 clearance；Output 由 Reconciler 检查后投递。

Note 是近期与长期认识的统一正文资源。Agent 结合已有 Note 和最新 Input 形成判断，按需修订 Note、推进工作并产生必要的 Output。普通 Note 是独立的事项认识，将围绕同一件事的多条 Input 整合为持续更新的当前认识。它保留理解这件事所需的进展、依据、结论和未决问题，以稳定 ID 承接后续变化。Note 通常跨越多条 Input 跟进一件具体事情，summary 从中选择更长期、可复用的认识，通过 summaryOf 关联其所总结的对象。Chief 和 Work Agent 通过统一 upsert_note 维护 Note；subject 关联主题或工作，people 关联涉及的人物。

Note 为主题与人物的长期认识、主题组织提供依据，提炼主线见 [Personal](README.md#从-input-到认识与成果)。summary 选择长期有效的内容，recent 按更新时间查询 Note；近期展示窗口与 Note 的独立生命周期分别管理。

## 模型与查询

| 字段 | 含义 |
| --- | --- |
| metadata.name / uid | 稳定 Note ID 和具体资源实例 |
| spec.subject | 必填的 Topic / Task / Routine / Person UID 引用；subject 表示认识的关联对象，people 表示相关人物 |
| spec.summaryOf | 可选的摘要对象引用，与 subject 一致；按对象 UID 索引，每个对象至多一份摘要 Note |
| spec.people | 涉及的人物引用，按 UID 去重；默认空数组 |
| spec.text | 事项或长期摘要的完整正文，最多 16000 字符；摘要正文可清空 |
| metadata.creationTimestamp | 创建时间 |
| status.updatedAt | 最近一次内容修改时间 |
| status.writer | Agent 写入者资源和 executionId；用户编辑、配置合并与 Weave 创建摘要不伪造 Agent 执行身份 |
| status.reviewTopic | 当前回顾 root 的最终一致缓存，仅用于依赖唤醒；真实归属从 subject 沿 parent 求得 |
| status.reviewed | Chief 已检查的内容版本与时间 |
| status.organization | 最近一次移动的来源、目标、原因与时间 |

subject 和 people 均有索引；recentSubject / recentPeople 另按 updatedAt 排序，recent 直接查询最新 40 条后应用字符预算，不加载全部历史。Topic 按自身 UID 查询 Note，相关 Work 的 Note 通过 Work 视图展示；Person 按 people 查询，同一 Note 可以出现在多个人物视图中。不是将正文复制进每个对象。普通事项没有配置 owner；subject / people 不阻止其所关联资源回收。Person 合并保留历史 people 引用，不将旧人物证据自动改写成目标人物。

## 作为 summary 的 Note

Note 首先是一份独立认识，text、people、subject 和内容版本使用同一套模型。摘要 Note 的 summaryOf 指向它所总结的 Topic、Task、Routine 或 Person，与 subject 一致；普通事项 Note 不设置 summaryOf。四类对象不再保存 summary 字段，正文只保存在 Note.spec.text。

summaryOf 按对象 UID 建立索引，事务校验每个对象至多一份摘要 Note，读取无需扫描 Note 列表。已有同 subject 的 Note 可设置 summaryOf；一旦设置，该关联不可修改，归位工具只移动普通事项 Note。summarize_* 在没有摘要时创建 Note，内部名称 summary-<resource uid> 仅保证创建重试幂等，不用于识别摘要角色。之后修改正文或 people 均保持 Note UID；清空正文也保留身份。

summarize_topic / summarize_task / summarize_routine / summarize_person 是维护摘要 Note 的便捷入口，支持 people；省略保留已有关联，[] 明确清空。upsert_note 也能编辑同一份 Note，自动原子同步对象上的内容指纹。只改 people 也改变内容版本，避免元数据变化绕过并发与依赖检查。用户仅修订正文时保留 people；Person 合并双方正文与 people，并保留历史人物引用，不猜测或重写来源。

读取和常驻上下文提供正文与 summaryNote（id、uid、version、subject、summaryOf、people），部分列表另投影 summaryUid。自动上下文最多预览 8 个人物关联并标明省略数量；read_note 可按 Note ID 或 UID 读取完整内容与关联。Note 正文与分类可独立编辑，省略字段保留原值；摘要 Note 通过同一更新入口保持依赖指纹一致。Output 记录实际使用的 Note UID、读取版本和接纳时校验的正文指纹；summary Note 与普通 Note 使用相同的 sensitivity、visibility 和披露检查。

recent 展示与普通事项提炼队列排除 summaryOf 非空的 Note，摘要通过独立位置展示；list_notes 仍可查到它。Note Reconcile 对摘要只修复对象上的派生内容指纹，不将它重复送入自己的事项提炼队列。

**summaryOf 指向的具体对象仍存在时，Note 不参与普通容量回收。** retention.canEvict 在实际淘汰事务内按 UID 检查对象是否存在，包括已标记删除但尚未移除的对象；直接删除这份 Note 同样被拒绝。对象实际移除后，Note 成为普通容量候选，无需先清空 summaryOf；同名重建的新对象不会保护指向旧 UID 的 Note。没有独立摘要 TTL，也不按名称直接删除 Note。关联不构成反向保留引用，不阻止对象本身回收。

本模型使用新的资源 API 版本，不兼容旧的内联 summary 数据，不提供自动迁移或双写。

## 工具与并发

upsert_note 的 subject 默认当前 Topic 或当前 Work；Chief 可指定自己当前子树中的 Topic / Task / Routine，Work Agent 只可写自身。people 省略保留已有值，[] 明确清空；不能凭姓名猜测 UID。

不传 noteId 时创建，不需要版本；同一执行内相同 tool-call identity 使用同一 Note 名称，重试返回已有 Note，不能覆盖较新的进展。传 noteId 时必须提交该 Note 的 version，由 UID、完整 spec 和内容更新时间计算。不存在或已淘汰的 ID 拒绝更新。相同内容不刷新年龄或版本。

list_notes 按 subject UID、people 中的 Person UID 和文本 q 查找保留的 Note。每次最多扫描一页索引结果，返回有界预览与 continue；搜索无匹配仍可能有下一页。它覆盖 recent 之外的 Note；Work Agent 的查询固定到自身。read_note 提供完整正文。

read_topic、read_task、read_routine、read_person 返回按更新时间排序的 recent 视图；read_note 按 Note ID 返回完整正文及版本。recent 最多 40 条、合计 16000 字符，是展示预算，不截断存储正文。常驻背景进一步缩减为 3 条、每条 500 字符。被截断时先 read_note 再修改，不能把预览当完整原文。

Note 的替换只校验该 Note 的内容；摘要的编辑同时更新所总结对象的派生内容指纹。不同 Note 和调度字段互不构成编辑冲突。Note Validator 在事务内核验执行仍活跃、目标仍存在、当前归属仍在写入者范围内。Weave 挂靠后仍在收尾的旧 Chief 可完成自身剩余子树的内容写入，不能越过新的归属边界。

summary 工具使用对象 UID 与 summaryRevision 计算内容版本，summaryRevision 本身包含 Note UID 与内容版本。Note 正文、summaryOf 与对象上的派生指纹在同一事务提交，JSON test 检查实际材料内容；contextWriter 记录执行依据，Note Validator 读取实际执行与祖先链。summaryRevision 仅为 Note 内容指纹的派生投影，供纯索引、Watch 和父子认知检查使用；常规编辑原子更新，Note Reconcile 修复独立资源更新后的投影，不要求历史作者仍在执行。Person 的 Web 资料整体编辑仍使用资源版本，summary 工具读取 read_person.summaryVersion。

Topic understandingVersion 纳入其查询窗口中 Note 的 UID 和版本。子理解吸收、删除和 Weave 归组在事务中重新查询 Note 索引，避免独立 Note 的新增/修改绕过 Topic 版本检查。Note 的回顾与上下文预览分别管理，具体流程见下节。

## 事项归位与提炼回顾

move_note 接受 noteId、version、目标 subject 和 reason。当前 root Chief 可在责任树内移动 Note，来源和目标均在写入事务内校验，目标可以是 Topic / Task / Routine。移动保留 ID、正文、people 和内容更新时间，记录组织调整；subject 改变使内容版本和旧回顾回执失效。upsert_note 专注内容维护，已有 Note 的归位使用 move_note。

每个未回顾的事项 Note 通过自己的 Reconcile 实时解析当前 root，包括 Work Note 和 root 自身的 Note，将当前版本加入 root 的有界回顾队列。队列满时重试；领取前重新核对 Note 是否仍存在、是否已回顾、版本和当前 root，覆盖主题改树与 Note 移动。每轮最多回顾 20 条，复用 aide:review 和 Chief，无需遍历所有 Topic / Work / Note 才发现待办。

Chief 完整读取事项后，决定更新 Topic、Person 的摘要 Note 或主题结构，也可以确认无需提炼。review_notes 只确认已检查的版本，不强制 summary 更新，不确认 Input 或 Work 完成。请求按 Note ID 表达集合：重复相同版本只确认一次，同一 ID 的不同版本明确拒绝。已确认的相同版本再次提交成功且保留首次确认时间；返回唯一 Note 数量。整批原子提交，任何内容版本过期或权限失效均回滚，并指出需要重读的 Note。确认只 Patch 回执和写入身份；首次回执使用显式 CAS 与有界资源重试串行化，重试不替换调用者提供的内容版本。即使是空操作也在事务内重新检查当前执行与归属。

确认不改变内容版本和更新时间；后续内容或 subject 变化重新获得回顾机会。业务接纳保持原有优先级，Note 提炼属于知识维护，不受普通静默回顾开关限制；失败和无进展会退避，取得进展后复位。

## 生命周期与容量

普通事项 Note 没有 TTL，不随 subject 或 people 删除。NoteDefinition 从 updatedAt 提供释放顺序，复用 ResourceStorage 数量配额，例如：

```yaml
resources:
  kinds:
    aide.dev/Note:
      maxCount: 1000
```

数量配额统计全部 Note，summaryOf 指向仍存在对象的 Note 受保护；达到配额时回收最久未更新的合格事项 Note，低水位和通用字节限制仍按 [Resource 容量](../plugin/resource.md#resource-容量) 执行。持有长期 summary 的对象不因此被删。显式删除使用标准无外部清理的 Reconcile；容量淘汰直接更新存储和索引。

## 版本与验证

Topic、Task、Routine 使用 aide.dev/v1alpha4，Person 使用 aide.dev/v1alpha3，Note 使用 aide.dev/v1alpha3。模型字段和当前校验以各资源定义为准。

摘要引用场景见 tests/summary-notes.test.ts；事项场景见 tests/note-knowledge.test.ts、tests/notes.test.ts、tests/topic-persons.test.ts 和 tests/pi-agent.test.ts：独立并发、同 Note 冲突、创建重试、过期执行、祖先归属竞争、悬空历史引用、容量回收、完整读取与真实工具路径。

Note 回顾请求与 nextAbsorbAt / absorbAttempts 在同一事务提交；Topic 的无关状态更新不制造请求冲突。创建时在事务内核验目标 Topic 仍存在且是空闲 root；普通回顾要求开关开启，Note 回顾独立于该开关。并发请求按 Topic / origin 的 pending 索引去重，复用已有 Input，不重复推进冷却。

Note Controller 监听内容变化、直属 Topic / Work 归属变化及 root 回顾队列腾位，每次最多唤醒 40 个索引匹配的 Note。reviewTopic 缓存更新不要求历史内容作者仍在执行，也不改变内容版本或保留年龄；内容编辑与回顾仍检查当前权限。队列满时保留待办，每个未回顾 Note 以 15 分钟周期修复漏事件和祖先层级变化；事件不承担持久投递保证。
