# Note

披露权限与实际投递见 [披露边界](disclosure.md)：材料使用 sensitivity/visibility，人物使用 clearance；Output 由 Reconciler 检查后投递。

Note 是近期与长期认识的统一正文资源。Agent 结合已有 Note 和最新 Input 形成判断，按需修订 Note、推进工作并产生必要的 Output。普通 Note 是独立的事项认识，将围绕同一件事、适用同一组 sensitivity/visibility 的事实整合为持续更新的当前认识。分类或受众范围不同的事实另建 Note；是否同一事项与是否同一分类共同决定新增还是更新。它保留理解这件事所需的进展、依据、结论和未决问题，以稳定 ID 承接后续变化。Note 通常跨越多条 Input 跟进一件具体事情，summary 从中选择更长期、可复用的认识，通过 summaryOf 关联其所总结的对象。Chief 和 Work Agent 通过统一 upsert_note 维护 Note；subject 关联主题或工作，people 关联涉及的人物。

Note 为主题与人物的长期认识、主题组织提供依据，提炼主线见 [Personal](README.md#从-input-到认识与成果)。summary 选择长期有效的内容，recent 按更新时间查询 Note；近期展示窗口与 Note 的独立生命周期分别管理。

## 模型与查询

| 字段 | 含义 |
| --- | --- |
| metadata.name / uid | 稳定 Note ID 和具体资源实例 |
| spec.subject | 必填的 Topic / Task / Routine / Person / Address UID 引用；subject 表示认识的关联对象，people 表示相关人物 |
| spec.summaryOf | 可选的摘要对象引用，与 subject 一致；按对象 UID 索引，每个对象至多一份摘要 Note |
| spec.people | 涉及的人物引用，按 UID 去重；默认空数组 |
| spec.addresses | 涉及的 Address UID 集合，近期记录按此关联分页，不改变 subject |
| spec.sensitivity / visibility | 整条 Note 统一适用的敏感度与可见范围；定级和拆分规则见 [披露边界](disclosure.md#定级与-note-边界) |
| spec.nature | 可选：episodic 事件经历、semantic 事实与长期认识、procedural 方法与步骤；按主要内容选择，与 summaryOf 独立，旧 Note 不自动分类 |
| spec.maxChars | 正文字符数软预算，缺省 4000；普通 Note 与 summary 共用，可按篇覆盖，超额仍能保存 |
| spec.text | 事项或长期摘要的完整正文，最多 16000 字符；摘要正文可清空 |
| metadata.creationTimestamp | 创建时间 |
| status.updatedAt | 最近一次内容修改时间 |
| status.writer | Agent 写入者资源和 executionId；用户编辑、配置合并与 Weave 创建摘要不伪造 Agent 执行身份 |
| status.pruned / retired | 最近删减或整篇退役的时间、原因、执行身份；退役保留正文和原内容版本 |
| status.organization | 最近一次移动的来源、目标、原因与时间 |

subject、people 和 addresses 均有索引；recentSubject / recentPeople / recentAddresses 另按 updatedAt 排序，recent 直接查询最新 40 条后应用字符预算，不加载全部历史。Topic 按自身 UID 查询 Note，相关 Work 的 Note 通过 Work 视图展示；Person 按 people 查询，同一 Note 可以出现在多个人物视图中。不是将正文复制进每个对象。普通事项没有配置 owner；subject / people 不阻止其所关联资源回收。Person 合并保留历史 people 引用，不将旧人物证据自动改写成目标人物。

## 作为 summary 的 Note

Note 首先是一份独立认识，text、people、subject 和内容版本使用同一套模型。摘要 Note 的 summaryOf 指向它所总结的 Topic、Task、Routine、Person 或 Address，与 subject 一致；普通事项 Note 不设置 summaryOf。这些对象不再保存 summary 字段，正文只保存在 Note.spec.text。

summaryOf 按对象 UID 建立索引，事务校验每个对象至多一份摘要 Note，读取无需扫描 Note 列表。已有同 subject 的 Note 可设置 summaryOf；一旦设置，该关联不可修改，归位工具只移动普通事项 Note。summarize_* 在没有摘要时创建 Note，内部名称 summary-<resource uid> 仅保证创建重试幂等，不用于识别摘要角色。之后修改正文或 people 均保持 Note UID；清空正文也保留身份。

summarize_topic / summarize_task / summarize_routine / summarize_person 是维护摘要 Note 的便捷入口，支持 people；省略保留已有关联，[] 明确清空。upsert_note 也能编辑同一份 Note，自动原子同步对象上的内容指纹。只改 people 也改变内容版本，避免元数据变化绕过并发与依赖检查。用户仅修订正文时保留 people；Person 合并双方正文与 people，并保留历史人物引用，不猜测或重写来源。

读取和常驻上下文提供正文与 summaryNote（id、uid、version、subject、summaryOf、people），部分列表另投影 summaryUid。自动上下文最多预览 8 个人物关联并标明省略数量；read_note 可按 Note ID 或 UID 读取完整内容与关联。Note 正文与分类可独立编辑，省略字段保留原值；摘要 Note 通过同一更新入口保持依赖指纹一致。upsert_note 的回执提供 noteId、uid、version：noteId 用于继续编辑，uid/version 可直接用于 say.notes 或 cite_output，调用方无需推断 UID。Stream.status.references 记录实际使用的 Note UID、读取版本和接纳时校验的正文指纹；summary Note 与普通 Note 使用相同的 sensitivity、visibility 和披露检查。

recent 展示排除 summaryOf 非空的 Note，摘要通过独立位置展示；list_notes 仍可查到它。Note Reconcile 对摘要只修复对象上的派生内容指纹。

**summaryOf 指向的具体对象仍存在时，Note 不参与普通容量回收。** retention.canEvict 在实际淘汰事务内按 UID 检查对象是否存在，包括已标记删除但尚未移除的对象；直接删除这份 Note 同样被拒绝。对象实际移除后，Note 成为普通容量候选，无需先清空 summaryOf；同名重建的新对象不会保护指向旧 UID 的 Note。没有独立摘要 TTL，也不按名称直接删除 Note。关联不构成反向保留引用，不阻止对象本身回收。

本模型使用新的资源 API 版本，不兼容旧的内联 summary 数据，不提供自动迁移或双写。

## 工具与并发

Chief 的 upsert_note 新建时可指定 topicId，目标必须在当前责任树内；省略时挂在当前 Chief 的 root Topic。更新已有 noteId 时只编辑内容与分类、人物等关联，保留原 subject，不因 Chief 当前在 root 执行而迁移；改变归属使用 move_note。此语义不随 Input.origin 改变。Work Agent 默认并且只可写自身。people 省略保留已有值，[] 明确清空；不能凭姓名猜测 UID。

不传 noteId 时创建，不需要版本；同一执行内相同 tool-call identity 使用同一 Note 名称，重试返回已有 Note，不能覆盖较新的进展。传 noteId 时必须提交该 Note 的 version，由 UID、完整 spec 和内容更新时间计算。不存在或已淘汰的 ID 拒绝更新。相同内容不刷新年龄或版本。

list_notes 按 subject UID、people 中的 Person UID 和文本 q 查找活跃的 Note，默认排除退役记录。每次最多扫描一页索引结果，返回有界预览与 continue；搜索无匹配仍可能有下一页。它覆盖 recent 之外的 Note；Work Agent 的查询固定到自身。read_note 提供完整正文；显式读取退役 Note 时同时返回 retired 回执。

read_topic、read_task、read_routine、read_person 返回按更新时间排序的 recent 视图；read_note 按 Note ID 返回完整正文及版本。recent 最多 40 条、合计 16000 字符，是展示预算，不截断存储正文。常驻背景进一步缩减为 3 条、每条 500 字符。被截断时先 read_note 再修改，不能把预览当完整原文。

Note 的替换只校验该 Note 的内容；摘要的编辑同时更新所总结对象的派生内容指纹。不同 Note 和调度字段互不构成编辑冲突。Note Validator 在事务内核验执行仍活跃、目标仍存在、当前归属仍在写入者范围内。Weave 挂靠后仍在收尾的旧 Chief 可完成自身剩余子树的内容写入，不能越过新的归属边界。

summary 工具使用对象 UID 与 summaryRevision 计算内容版本，summaryRevision 本身包含 Note UID 与内容版本。Note 正文、summaryOf 与对象上的派生指纹在同一事务提交，JSON test 检查实际材料内容；contextWriter 记录执行依据，Note Validator 读取实际执行与祖先链。summaryRevision 仅为 Note 内容指纹的派生投影，供纯索引、Watch 和父子认知检查使用；常规编辑原子更新，Note Reconcile 修复独立资源更新后的投影，不要求历史作者仍在执行。Person 的 Web 资料整体编辑仍使用资源版本，summary 工具读取 read_person.summaryVersion。

Topic understandingVersion 纳入其查询窗口中 Note 的 UID 和版本。子理解吸收、删除和 Weave 归组在事务中重新查询 Note 索引，避免独立 Note 的新增/修改绕过 Topic 版本检查。上下文预览与整理触发分别管理，具体流程见下节。

## 事项归位与提炼回顾

move_note 接受 noteId、version、目标 subject 和 reason。当前 root Chief 可在责任树内移动 Note，来源和目标均在写入事务内校验，目标可以是 Topic / Task / Routine。移动保留 ID、正文、people 和内容更新时间，记录组织调整；subject 改变使内容版本变化。upsert_note 专注内容维护，已有 Note 的归位使用 move_note。

普通 Note 的新增或更新不创建逐条 review 请求，不保留回顾队列或逐条确认回执。写入 Agent 负责当次内容质量、分类与受众；后续在预算压力整理或定时回顾中按需检查、合并和提炼。summary 变化继续通过子 Topic 认识吸收路径处理。

## 数量与篇幅驱动的整理

Input 保留大量短暂、步骤级证据；普通 Note 汇集近期事项；summary Note 沉淀对人、事、场合的长期认识。nature 描述知识性质，不是成熟度或独立的 Skill。整理通过现有 Topic 组织与 Note 工具完成，不引入 Note tree 或知识点实体。

每个 Topic 用 spec.maxNotes 覆盖全局 topic.maxNotes（默认 10），只统计直属活跃普通 Note，排除 summary、退役和正在删除的记录，子 Topic 独立计算。maxChars 属于 Note，普通 Note 与 summary 使用同一字段和规则。topic.maxChars 为新建 Topic Note 提供默认篇幅预算；其余入口缺省 4000，更新保留原预算。字符计量沿用正文上限的 JavaScript UTF-16 length。预算不自动截断正文，不拒绝超额保存；16000 字符仍是单篇存储上限。读取上下文的总字符预算独立管理。

Topic Reconcile 在 Note 变化时检查压力，周期唤醒兜底。数量查询最多读取 maxNotes+1 条；超长 Note 用独立索引查询，包含 summary，最多 20 条。每个 Topic 持有有界压力快照，按当前 root 与下次尝试时间建立索引，Chief 每轮最多取得 8 个 Topic；不会在每次 root 唤醒时全量遍历 Note 历史。

压力通过 aide:review、trigger=note_pressure 安排 Chief 整理，独立于普通定时 review 开关；业务输入优先。已有 review Input 时，在实际执行时合并当前到期压力，不因请求去重丢失其他 Topic。调用前持久化冷却与失败退避；完成后只确认实际呈现的材料版本。prune、retire、move 的执行回执证明本轮确实削减过来源，即使被削减的旧 Note 不在有界计数样本内，也会在冷却后继续；没有削减且材料未变化时不反复调用模型。新材料或预算变化重新进入判断；数量、长度降到预算内时清除压力。无法安全压缩时允许超额，并完成本轮回执。

upsert_note 负责整合目标信息；prune_note 接受 noteId、version、完整的更短非空正文和 reason，只削减来源正文，保留元数据，也支持 summary 的原子指纹更新；retire_note 接受 noteId、version、reason，让整篇 Note 退出活跃使用。两种削减操作由 review 中的 Chief 使用，事务内校验执行身份、当前归属与版本。仍有归属对象的 summary 禁止退役。

信息移动始终先成功写入目标，再 prune 来源；来源没有独立价值才 retire。中断可以留下重复，不能先删来源再尝试保存目标。Agent 按重要性、稳定性、证据与未决问题决定合并、归位或沉淀，不为达到数量强行删除，也不通过抬高预算逃避整理。

## 生命周期与容量

退役是逻辑状态：退出 recent、默认列表与数量/篇幅统计，正文、分类、年龄及已有引用不变，不支持重新激活或继续编辑。仍可按 ID 显式查询；物理回收继续使用原容量生命周期。保留的 Stream 通过通用 retention.references 固定其引用的 Note，因此生成结束但尚未投递的 Output 不会因整理退役失去证据；Stream 被回收后才释放引用保护。

普通事项 Note 没有 TTL，不随 subject 或 people 删除。NoteDefinition 从 updatedAt 提供释放顺序，复用 ResourceStorage 数量配额，例如：

```yaml
resources:
  kinds:
    aide.dev/Note:
      maxCount: 1000
```

数量配额统计全部 Note，summaryOf 指向仍存在对象的 Note 受保护；达到配额时回收最久未更新的合格事项 Note，低水位和通用字节限制仍按 [Resource 容量](../plugin/resource.md#resource-容量) 执行。持有长期 summary 的对象不因此被删。显式删除使用标准无外部清理的 Reconcile；容量淘汰直接更新存储和索引。

## 版本与验证

Topic、Task、Routine 使用 aide.dev/v1alpha4，Person 使用 aide.dev/v1alpha3，Note 使用 aide.dev/v1alpha4。模型字段和当前校验以各资源定义为准。

摘要引用场景见 tests/summary-notes.test.ts；事项场景见 tests/note-knowledge.test.ts、tests/notes.test.ts、tests/topic-persons.test.ts 和 tests/pi-agent.test.ts：独立并发、同 Note 冲突、创建重试、过期执行、祖先归属竞争、悬空历史引用、容量回收、完整读取与真实工具路径。

review 请求与 reviewCheckedAt 在同一事务提交，Topic 的无关状态更新不制造请求冲突。创建时在事务内核验目标 Topic 仍存在且是空闲 root；定时回顾要求开关开启，预算压力与认识吸收独立于该开关。并发请求按 Topic / origin 的 pending 索引去重。

Note Controller 只修复 summary 派生指纹。Topic 监听 Note 内容和退役状态变化以检查预算压力，周期检查兜底；预算内的普通 Note 变化不会立即调用模型。旧版存储的逐条 review 字段在解码时丢弃，旧版排队中的逐条 review Input 直接结束，当前预算压力与 summary 变化分别重新判断。

Web 的近期记录项及 summary 正文左下角展示 sensitivity、visibility 和已设置的 nature 原值（例如 `L1 · any · semantic`）；未设置 nature 时省略，属性修改即使不改变正文，也会刷新标记。
