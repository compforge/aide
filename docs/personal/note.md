# Note

披露权限与实际投递见 [披露边界](disclosure.md)：材料使用 sensitivity/visibility，人物使用 clearance；Output 由 Reconciler 检查后投递。

Note 是近期与长期认识的统一正文资源。Agent 结合已有 Note 和最新 Input 形成判断，按需修订 Note、推进工作并产生必要的 Output。普通 Note 是独立的事项认识，将围绕同一件事、适用同一组 sensitivity/visibility 的事实整合为持续更新的当前认识。分类或受众范围不同的事实另建 Note；是否同一事项与是否同一分类共同决定新增还是更新。它保留理解这件事所需的进展、依据、结论和未决问题，以稳定 ID 承接后续变化。Note 通常跨越多条 Input 跟进一件具体事情，summary 从中选择更长期、可复用的认识，通过 summaryOf 关联其所总结的对象。Chief 和 Work Agent 通过统一 upsert_note 维护 Note；subject 关联主题或工作，people 关联涉及的人物。

Note 为主题与人物的长期认识、主题组织提供依据，提炼主线见 [Personal](README.md#从-input-到认识与成果)。summary 选择长期有效的内容，recent 按更新时间查询 Note；近期展示窗口与 Note 的独立生命周期分别管理。

## 梳理与提炼

### 初记与梳理

Chief 的首要任务是处理 Input。有值得留存的事实或未决事项时，Chief 才新建或更新普通 Note。这份记录是基于当时证据形成的初步认识。单条 Input 可能只反映一方的说法或某个阶段的进展，初次记录应保留来源、适用范围和待核实之处，`nature` 可以暂缺。后续 Input 围绕同一事项补充证据时，Chief 可以继续修订同一篇 Note。

Secretary 把同一 root Topic 下有实质变化的普通 Note 放进同一份梳理议程。默认攒到 8 篇或最早一篇等满 15 分钟就申请一次 `aide:curate`。正文、归属、关联对象、披露范围、nature 变化都值得再看。改名或调整篇幅预算沿用上次梳理结果。工作量、子摘要变化与预算压力也可以触发梳理。

Chief 处理 `aide:curate` 时，对照相关 Input、Work 和其他 Note 核对事实，为保留的内容选定 `nature`，按需纠正早先的判断、拆开混杂的事项或合并重复记录。若现有内容和分类已经恰当，核对后即可确认当前版本。Chief 在 `assess_input.curatedNotes` 中提交实际梳理过的普通 Note 及其最终版本，包括拆分、合并的目标。如果草稿里还有要办的事，先查已有 Work。在授权范围内追加材料、更新 Ongoing，或引用这篇 Note 创建合适的责任。确认 Work 已承接后，保留 Note 中仍有独立价值的事实与方法；整篇仅重复工作安排时可以退役。

梳理回执逐篇记录结果，与已确认版本在同一事务保存。部分版本过期时，有效回执仍然生效。整批提交都无法确认且有版本冲突或缺少 nature 时，Chief 有一次在本轮重读并更正的机会。仍未解决的材料保留在待梳理队列，以本轮暂缓时间参与下一轮排序，让其他等待中的 Note 先得到处理。

### 从事项结论到长期认识

梳理回执表明 Chief 已核对这篇 Note 的当前内容。事项仍在进行时，普通 Note 也可以准确记录已知事实和未决问题，供后续跟进。需要持续跟进的责任及其收尾结论由 [Ongoing](ongoing.md) 保存。Chief 核对事项结论及其适用范围后，按需将稳定认识提炼到对象摘要。若新证据表明已有 Summary 中的判断失实或适用范围过宽，Chief 在该对象的 aide:summary 复核中修正。

## 模型与查询

| 字段 | 含义 |
| --- | --- |
| metadata.name / uid | 稳定 Note ID 和具体资源实例 |
| spec.name | 可维护的事项或知识名称，最长 200 字符；读取与更新使用稳定 ID |
| spec.subject | 必填的 Topic / Task / Routine / Person / Address UID 引用；subject 表示认识的关联对象，people 表示相关人物 |
| spec.summaryOf | 可选的摘要对象引用，与 subject 一致；按对象 UID 索引，每个对象至多一份活跃摘要 Note |
| spec.people | 涉及的人物引用，按 UID 去重；默认空数组 |
| spec.addresses | 涉及的 Address UID 集合，近期记录按此关联分页，不改变 subject |
| spec.sensitivity / visibility | 整条 Note 统一适用的敏感度与可见范围；定级和拆分规则见 [披露边界](disclosure.md#定级与-note-边界) |
| spec.nature | 可选：semantic 事实与长期认识、procedural 方法与步骤；按主要内容选择，与 summaryOf 独立，暂缺的普通 Note 由 Secretary 到期安排归类 |
| spec.maxChars | 正文字符数软预算，缺省 4000；普通 Note 与 summary 共用，可按篇覆盖，超额仍能保存 |
| spec.text | 事项或长期摘要的完整正文，最多 16000 字符；摘要正文可清空 |
| metadata.creationTimestamp | 创建时间 |
| status.updatedAt | 最近一次内容修改时间 |
| status.writer | Agent 写入者资源和 executionId；用户编辑、配置合并与 Weave 创建摘要不伪造 Agent 执行身份 |
| status.curationRetry | 最近一次暂缓的材料指纹、时间和梳理 Input UID |
| status.curated | 最近一次确认的材料指纹和梳理 Input UID，可回查该次完成回执 |
| status.pruned / retired | 最近删减或整篇退役的时间、原因、执行身份；退役保留正文和原内容版本 |
| status.splitFrom | 新篇记录拆分来源 Note 的 UID 和当时的内容版本 |
| status.organization | 最近一次移动的来源、目标、原因与时间 |

subject、people 和 addresses 均有索引；recentSubject / recentPeople / recentAddresses 另按 updatedAt 排序，recent 直接查询最新 40 条后应用字符预算，不加载全部历史。Topic 按自身 UID 查询 Note，相关 Work 的 Note 通过 Work 视图展示；Person 按 people 查询，同一 Note 可以出现在多个人物视图中。不是将正文复制进每个对象。普通事项没有配置 owner；subject / people 不阻止其所关联资源回收。Person 合并保留历史 people 引用，不将旧人物证据自动改写成目标人物。

## 名称与按需读取

普通 Note 创建时由 Agent 提供简明名称，事项范围变化或整理后按需更新。`upsert_note` 可单独修改 name，省略时保留原名；名称不要求唯一，改名保留 ID、UID 与正文引用。`list_notes` 同时搜索名称和正文。

未命名 Note 以正文首个非空行作为占位名称，读取投影带 `nameMissing: true`，Web 显示 `[未命名]`。Agent 在维护该 Note 时补齐名称；补齐前不改写存储。Summary 由所属对象识别，无需额外命名。

Prompt 中的 summary 提供紧凑背景，普通 Note 目录只包含 id、name、nameMissing、nature、updatedAt 和 version。目录独立于正文预览预算，选取最新 40 条并按稳定 ID 排序，最多 8000 个 JSON 字符；提供总数（已知时）、truncated 与 list_notes 查询条件。异步有界读取无法确定总数时明确截断，不把当前页数量当作总量。Topic、Person、Address 和 Work 按各自关联查询；退休 Note 和 summary 不进入普通目录。Agent 根据名称判断相关性，再以 read_note 读取完整内容。Chief、Gate 和 Work 复用只读 Note 检索；读取证据不授予修改其它资源的权限，写入继续校验当前执行和 subject 归属。

目录随每次模型调用重新生成，新增、改名、内容更新、移动和退休都反映到下一次请求。当前背景 part 直接替换，历史消息保留。目录变化可能降低 prefix cache 复用；以信息准确性和任务效果为先，结合缓存使用、token 与延迟衡量成本。

## 作为 summary 的 Note

summary 与普通事项使用同一种 Note 载体，共用正文、关联、内容版本、分类与 maxChars 软预算；差别在于认识的视角、内容层级与上下文使用方式。普通 Note 围绕具体事项保存进展、依据、结论和未决问题；summary Note 从特定对象的视角提炼跨事项、长期有效的认识：Topic 面向主题与领域，Person 面向人物，Address 面向沟通场合。summary Note 面向常驻上下文，提供紧凑、稳定的对象认识，具体加载范围由当前任务和上下文预算决定；普通 Note 通过名称目录发现，使用 read_note 按稳定 ID 获取正文及其依据。

Chief 复核摘要时，从下一次使用这个对象的场景出发。

| 对象 | 复核要回答的问题 |
| --- | --- |
| Topic | 下次继续处理这个主题，哪些范围、约束、决策和可复用结论能帮助判断？子主题里的细节只有能解释整个主题时才提炼到父摘要。 |
| Person | 下次因为另一件事与这个人协作，应该预先知道哪些仍然成立的职责、本人表达的观点、偏好或协作方式？保留信息来源，一次分工的证据只支持那次分工。 |
| Address | 下次来到这个沟通场合，哪些用途、受众和沟通惯例有助于判断是否适合在这里谈、该怎么谈？已观察到的参与者只说明部分受众，实际披露仍按材料和投递规则判断。 |

每份 summary Note 专属于 summaryOf 指向的一个对象，与 subject 一致；现有模型支持 Topic、Task、Routine、Person 和 Address。普通事项 Note 不设置 summaryOf，通过 subject、people、addresses 在相关对象的视图中展示同一份记录；这种相关性展示不改变 summary 的专属归属。对象不再保存内联 summary 字段，正文统一保存在 Note.spec.text。

summaryOf 按对象 UID 建立索引，事务校验每个对象至多一份活跃摘要 Note，读取无需扫描 Note 列表。已有同 subject 的 Note 可设置 summaryOf；一旦设置，该关联不可修改，归位工具只移动普通事项 Note。首次为对象写摘要时创建 Note，内部名称按对象 UID 和上次退役摘要的 UID 生成，使同一轮创建可重试，每轮新摘要有独立 ID。之后修改正文或 people 均保持 Note UID；清空正文也保留身份。

Chief 在 aide:summary 中用 upsert_note 维护所选 Topic、Person 或 Address 的摘要，Task 和 Routine 各自维护本工作摘要。工具支持 people，省略保留已有关联，[] 明确清空。读取对象的 summaryNote，以 id 和 version 更新已有摘要。首次写入提供 summaryOf 对象引用和正文。摘要与对象内容指纹在同一事务提交。只改 people 也改变内容版本，避免元数据变化绕过并发与依赖检查。用户仅修订正文时保留 people；Person 合并双方正文与 people，并保留历史人物引用，不猜测或重写来源。

读取和常驻上下文提供正文与 summaryNote（id、uid、version、subject、summaryOf、people），部分列表另投影 summaryUid。自动上下文最多预览 8 个人物关联并标明省略数量；read_note 可按 Note ID 或 UID 读取完整内容与关联。Note 正文与分类可独立编辑，省略字段保留原值；摘要 Note 通过同一更新入口保持依赖指纹一致。upsert_note 的回执提供 noteId、uid、version：noteId 用于继续编辑，uid/version 可直接用于 say.notes 或 cite_output，调用方无需推断 UID。Stream.status.references 记录实际使用的 Note UID、读取版本和接纳时校验的正文指纹；summary Note 与普通 Note 使用相同的 sensitivity、visibility 和披露检查。

recent 展示排除 summaryOf 非空的 Note，摘要通过独立位置展示；list_notes 仍可查到它。Note Reconcile 对摘要只修复对象上的派生内容指纹。

**活跃摘要在其对象仍存在时受容量保护。** retention.canEvict 在实际淘汰事务内按 UID 检查对象是否存在，包括已标记删除但尚未移除的对象；直接删除这份 Note 同样被拒绝。对象实际移除后，Note 成为普通容量候选，无需先清空 summaryOf；同名重建的新对象不会保护指向旧 UID 的 Note。没有独立摘要 TTL，也不按名称直接删除 Note。关联不构成反向保留引用，不阻止对象本身回收。

本模型使用新的资源 API 版本，不兼容旧的内联 summary 数据，不提供自动迁移或双写。

## 工具与并发

Chief 的 upsert_note 新建时可指定 topicId，目标必须在当前责任树内；省略时挂在当前 Chief 的 root Topic。更新已有 noteId 时只编辑内容与分类、人物等关联，保留原 subject，不因 Chief 当前在 root 执行而迁移；改变归属使用 move_note。此语义不随 Input.origin 改变。Work Agent 默认并且只可写自身。people 省略保留已有值，[] 明确清空；不能凭姓名猜测 UID。

不传 noteId 时创建，不需要版本；同一执行内相同 tool-call identity 使用同一 Note 名称，重试返回已有 Note，不能覆盖较新的进展。传 noteId 时必须提交该 Note 的 version，由 UID、完整 spec 和内容更新时间计算。不存在或已淘汰的 ID 拒绝更新。相同内容不刷新年龄或版本。

list_notes 可组合 subject、people、addresses、文本 q 和 isSummary 条件。isSummary 省略时返回两类活跃 Note，true 只取摘要，false 只取普通 Note。每次最多扫描一页索引结果，返回有界预览与 continue；搜索无匹配仍可能有下一页。它覆盖 recent 之外的 Note；Work Agent 的查询固定到自身。read_note 提供完整正文；显式读取退役 Note 时同时返回 retired 回执。

read_topic、read_task、read_routine、read_person 返回按更新时间排序的 recent 视图；read_note 按 Note ID 返回完整正文及版本。recent 最多 40 条、合计 16000 字符，是展示预算，不截断存储正文。常驻背景进一步缩减为 3 条、每条 500 字符。被截断时先 read_note 再修改，不能把预览当完整原文。

Note 的替换只校验该 Note 的内容；摘要的编辑同时更新所总结对象的派生内容指纹。不同 Note 和调度字段互不构成编辑冲突。Note Validator 在事务内核验执行仍活跃、目标仍存在、当前归属仍在写入者范围内。Weave 挂靠后仍在收尾的旧 Chief 可完成自身剩余子树的内容写入，不能越过新的归属边界。

摘要写入使用对象 UID、summaryRevision 与上次退役摘要的 UID 计算对象内容版本，summaryRevision 本身包含 Note UID 与内容版本。Note 正文、summaryOf 与对象上的派生指纹在同一事务提交，JSON test 检查实际材料内容；contextWriter 记录执行依据，Note Validator 读取实际执行与祖先链。summaryRevision 仅为 Note 内容指纹的派生投影，供纯索引、Watch 和父子认知检查使用；常规编辑原子更新，Note Reconcile 修复独立资源更新后的投影，不要求历史作者仍在执行。Person 的 Web 资料整体编辑仍使用资源版本，summary 工具读取 read_person.summaryVersion。

Topic understandingVersion 纳入其查询窗口中 Note 的 UID 和版本。回收和 Weave 归组在事务中重新查询 Note 索引，避免独立 Note 的新增/修改绕过 Topic 版本检查。上下文预览与整理触发分别管理，具体流程见下节。

## 事项归位与提炼回顾

move_note 接受 noteId、version、目标 subject 和 reason。当前 root Chief 可在责任树内移动 Note，来源和目标均在写入事务内校验，目标可以是 Topic / Task / Routine。移动保留 ID、正文、people 和内容更新时间，记录组织调整；subject 改变使内容版本变化。upsert_note 专注内容维护，已有 Note 的归位使用 move_note。

curate 核对普通 Note 的证据与分类，organize 调整材料在 Topic 树中的归属。Chief 通过 `aide:summary` 单独复核某个对象的默认认识。对新材料，判断下次因另一件事接触这个对象时是否值得默认读到；对已有摘要，核对每项判断的依据、适用范围和确定程度。仍然准确时，完成复核即可。

## 数量与篇幅驱动的整理

Input 保留大量短暂、步骤级证据；普通 Note 汇集近期事项；summary Note 沉淀对人、事、场合的长期认识。nature 描述知识性质，不是成熟度或独立的 Skill。整理通过现有 Topic 组织与 Note 工具完成，不引入 Note tree 或知识点实体。

每个 Topic 用 spec.maxNotes 覆盖全局 topic.maxNotes（默认 10），只统计直属活跃普通 Note，排除 summary、退役和正在删除的记录，子 Topic 独立计算。maxChars 属于 Note，普通 Note 与 summary 使用同一字段和规则。topic.maxChars 为新建 Topic Note 提供默认篇幅预算；其余入口缺省 4000，更新保留原预算。字符计量沿用正文上限的 JavaScript UTF-16 length。预算不自动截断正文，不拒绝超额保存；16000 字符仍是单篇存储上限。读取上下文的总字符预算独立管理。

Topic Reconcile 在 Note 变化时检查压力，周期唤醒兜底。数量查询最多读取 maxNotes+1 条；超长 Note 用独立索引查询，包含 summary，最多 20 条。每个 Topic 持有有界压力快照，按当前 root 与下次尝试时间建立索引，Chief 每轮最多取得 8 个 Topic；不会在每次 root 唤醒时全量遍历 Note 历史。

压力通过 `aide:curate`、`trigger=note_pressure` 安排 Chief 整理，独立于普通回顾开关；业务输入优先。Secretary 在创建请求时选取到期压力，已创建的请求保持快照，后来的需求留待下一次。请求创建时持久化冷却；完成结果不再修改压力调度。Secretary 根据剩余压力继续安排，同一需求逐步退避，新正文或预算变化恢复基础节奏。数量、长度降到预算内时清除压力。无法安全压缩时允许超额，并完成本轮回执。

upsert_note 负责整合目标信息；prune_note 接受 noteId、version、完整的更短非空正文和 reason，只削减来源正文，保留元数据，也支持 summary 的原子指纹更新；retire_note 接受 noteId、version、reason，让整篇 Note 退出活跃使用。Chief 在 curate、organize 中可削减普通 Note，在 summary 中可削减所选对象的摘要，事务内校验执行身份、当前归属与版本。退役活跃摘要时，同一事务清除对象的 summaryRevision 并记录该摘要 UID。旧摘要保留原正文和内容版本，退出活跃摘要索引，新的摘要单独创建。

split_note 接受 noteId、version、reason、来源保留的更短非空正文 text 和新篇 parts。在同一事务写入来源、所有新篇和摘要对象指纹。来源保留 UID 与角色，新篇均为普通 Note，可以分别提供 name、nature 和 subject，继承来源的披露范围和人物、场合关联。重复相同请求返回已有 ID，复核后再提交梳理版本。

合并到已有 Note 时先成功写入目标，再 prune 来源；来源没有独立价值才 retire。中断可以留下重复，不能先删来源再尝试保存目标。Agent 按重要性、稳定性、证据与未决问题决定合并、归位或沉淀，不为达到数量强行删除，也不通过抬高预算逃避整理。

## 生命周期与容量

退役是逻辑状态：退出 recent、默认列表与数量/篇幅统计，正文、分类、年龄及已有引用不变，不支持重新激活或继续编辑。仍可按 ID 显式查询；物理回收继续使用原容量生命周期。保留的 Stream 通过通用 retention.references 固定其引用的 Note，因此生成结束但尚未投递的 Output 不会因整理退役失去证据；Stream 被回收后才释放引用保护。

普通事项 Note 没有 TTL，不随 subject 或 people 删除。NoteDefinition 从 updatedAt 提供释放顺序，复用 ResourceStorage 数量配额，例如：

```yaml
resources:
  kinds:
    aide.dev/Note:
      maxCount: 1000
```

数量配额统计全部 Note，summaryOf 指向仍存在对象的 Note 受保护；达到配额时回收最久未更新的合格事项 Note，低水位和通用字节限制仍按 [Resource 容量](../plugin/resource.md#resource-容量与释放) 执行。持有长期 summary 的对象不因此被删。显式删除使用标准无外部清理的 Reconcile；容量淘汰直接更新存储和索引。

## 版本与验证

Topic、Task、Routine 使用 aide.dev/v1alpha4，Person 使用 aide.dev/v1alpha3，Note 使用 aide.dev/v1alpha5。模型字段和当前校验以各资源定义为准。

摘要引用场景见 tests/summary-notes.test.ts；事项场景见 tests/note-knowledge.test.ts、tests/notes.test.ts、tests/topic-persons.test.ts 和 tests/pi-agent.test.ts：独立并发、同 Note 冲突、创建重试、过期执行、祖先归属竞争、悬空历史引用、容量回收、完整读取与真实工具路径。

Secretary 创建 curate 请求时原子保存触发依据和请求冷却，并按 Topic／origin 的 pending 索引去重。定时与工作量回顾受开关控制，预算压力独立于该开关。Note 压力按稳定材料身份、正文和预算生成需求指纹；改名与 updatedAt 不重置退避。完整 Note 版本继续用于读写与删除校验。

Note Controller 修复 summary 派生指纹；Secretary 的 Note 协调器负责梳理时机。Topic 监听 Note 内容和退役状态变化以检查预算压力，周期检查兜底；预算内的普通 Note 变化不会立即调用模型。

Web 的近期记录项及 summary 正文左下角展示 sensitivity、visibility 和已设置的 nature 原值（例如 `L1 · any · semantic`）；未设置 nature 时省略，属性修改即使不改变正文，也会刷新标记。
