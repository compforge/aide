# Input：事实与处理痕迹

披露权限与实际投递见 [披露边界](disclosure.md)：Note 使用 sensitivity/visibility，Input 不重复分类，人物使用 clearance；Output 由 Reconciler 检查后投递。

## 整体定位

Input 保存收到的内容及来源证据，各组件在同一资源上留下自己的处理进展。它使一条信息从接收到路由、研判和办理的过程可追溯。值得持续保留的事项认识由 [Note](note.md) 整合，再按其价值提炼长期认识或调整主题结构；原始内容仍由 Input 保存。认知沉淀与行动的关系见 [Personal](README.md#从-input-到认识与成果)。

`status.topic` 保存唯一的当前 Topic 归属，引用固定 UID。`status.route` 只保存首次路由处理记录；spec 中的 topicId / topicKey 保存入站定位信息。Chief 在树内移动 Input 时更新当前归属和迁移原因，保留原始事实与 route / assess / handle 回执；已接纳但尚未完成研判的 Input 先完成处理再迁移。内容查询使用 status.topic；自动待办查询使用 status.assess.topic。

## CRD

类型为 `aide.dev/v1alpha6 Input`。

### Spec

| 信息 | 含义 |
| --- | --- |
| text、observation | 来源内容与证据；外部观察保留事实，内置 Input 保存回顾、分理、组织请求及触发证据 |
| origin、originId、originRef | channel / source / chief / aide:review / aide:triage / aide:organize 分类、来源定义与可选产生资源引用 |
| sender、relation | 可选的发送 Person 引用，以及输入相对于 Me 的关系 |
| source | 可选 AddressRef，固定资源 UID，表示事情发生或可以联络的场合 |
| replyToMessageId | 可选原消息回复坐标，不参与 Address 身份 |
| inputKey | 可选的 producer 事件身份字符串，用于跨入口去重 |
| topicId、topicKey | TopicLocator 提供的精确 Topic ID 或稳定来源关联键 |
| topicName | 来源提供的初始名称建议；不参与匹配，不覆盖既有 Topic 名称 |
| attention | InputAttention 字符串枚举：immediate、normal、deferred，表达注意力调度需求 |

字段的完整类型与必选性见 [InputSpec](../../plugins/personal/input/model.ts)。人物、地址、话题线索和调度分别回答不同问题；紧迫性、来源和 relation 都不自动授予执行权限或要求外发。

### 人物与场合

IM 消息由 sender 在 source 指向的 Address 中发出。单聊与群聊都以场合表达可见范围；Input 不保存 receivers。Address.people 积累当前聊天中已确认的参与者，不声明完整或实时成员名单，也不代表实际已读。

mentions / mentionDetails 保留在 observation 中，表示正文提及与提醒。@ 不改变可见范围，也不能证明被提及者属于当前场合。Lark Channel 可根据平台明确的 user 类型发现 Person 及其联系地址，但不会把这些人物加入来源 Address；bot、Aide 自身和 @all 不建立 Person，类型未知时保留原始证据，不按名字合并跨应用身份。

Bot 单聊登记与机器人对话的人；Source 观察的人与人单聊登记观察账号与当前聊天中已确认的发言者。群聊积累当前聊天中实际发言的人；转发正文、跨场合引用和 mentions 中的人物不参与这项推导。多作者讨论的逐条 sender、relation 和原始 mentions 保留在 observation 中。

Chief 可从这些证据维护 Note 的相关人物；Topic 的近期人物继续从 Note 派生。相关人物与场合参与者是不同关系。验证见 `tests/lark.test.ts`、`tests/message-source.test.ts`、`tests/output-disclosure.test.ts`。

### Status

`status.topic` 由 Route 首次绑定、Chief 在合法树范围内调整；`organization` 保存最近一次移动的依据。`route` 保留首次路由结果和重试进度；`assess` 保存唯一研判和 Chief 接纳；`handle` 按 Work UID 保存请求、应用与办理回执。Input 不拥有独立会话或顶层 summary/recent。

| 条件 | 含义与维护者 |
| --- | --- |
| Assessed | Chief 的研判完成回执已提交 |
| HandlingComplete | 未完成研判时为 Unknown；研判后全部办理义务结束时为 True，成功与否仍读取各回执 |
| NeedsAttention | 未完成的研判或办理存在需核对的执行异常 |

处理回执构造函数将这些条件与事实一起提交，通用规则见 [Conditions](../plugin/resource.md#conditions-契约)。

## 处理组件的协作

Input Reconcile 负责确定研判分派，不启动 Agent；Route、Topic、Task、Routine 的 Reconciler 观察并处理属于自己的阶段。Agent 通过各角色工具提交判断。

### 内容、身份与调度

Immediate 在 Chief 空闲时启动处理，运行中通过 steer 加入；Normal 在空闲时启动处理，运行中通过 followUp 排队。Deferred 只路由和挂载，不因到达而启动所属 root Chief，也不进入其 steer / followUp 队列。Chief 因其它输入、定时回顾或知识整理运行时，可以顺带处理 Deferred；运行中主动发现的 Deferred 也可通过 assess_input 记录研判结果。

未填写 attention 时，Channel 默认 Immediate，Source / Chief / 内置 Input 默认 Normal。attention 不限制 Route 分类，也不阻止 Chief 明确交给 Task / Routine 的办理。Deferred 未被研判时保持待处理；Topic review 可以关闭，不增加独立批处理计时器。

Channel / Source 经绑定的入口提交 Input，稳定身份用于传输去重；接收回执只证明持久化成功。Source 先保存 Input，再推进观察水位。原始消息满足提交条件时，即使可选上下文读取失败仍可接收，具体证据与权限见对应接入文档。

系统内置 Input 使用 `origin: aide:review / aide:triage / aide:organize`，分别表示静默回顾、材料分理和子节点组织；originId 为 personal.topic，originRef 指向需要处理的 Topic。text 说明目的、范围和要求，observation 保存触发证据，不增加 maintenance 字段。它们不刷新业务活跃时间、不计入业务材料容量，也不增加外发授权。详见 [Topic 内置请求](topic.md#树内整理与维护优先级)。

### 路由、研判与办理

| status 阶段 | 写入者与完成条件 |
| --- | --- |
| route | Route 的规则或 route_input 保存完整去向与理由；内置 Input 在创建时直接写入待处理 Topic |
| assess | Topic Reconcile 原子记录 Chief 接纳；Chief 用 assess_input 确认 Input 的唯一研判 |
| handle[Work UID] | Work 应用请求，再用 report_task / report_routine 确认办理 |

route_input 在同一事务写入 route 结果和一条空 assess；assess_input 在同一事务完成研判并建立必要的 handle。目标引用固定 UID，不能把旧实例的请求转给同名新资源。一个 Input 只有一个当前材料 Topic 和一个研判负责人，保存一份研判；多个 Work 仍按各自 UID 独立确认。

未完成可能是尚未接纳、运行、退避或待核对。接纳记录不等于完成；原生调用结束也不代替工具回执。Route 分类失败可以按输入退避重试，Work 可能已经产生副作用，需核对后继续；Chief 执行失败记录在 Topic，未完成 Input 的 assess 保留接纳标记与异常供核对。详细策略分别归 [Route](route.md)、[Topic](topic.md)、[Task](task.md) 与 [Routine](routine.md)。

### 研判与办理

Chief 可以直接处理、创建或删除工作。将现有 Input 交给已有 Work 时，通过 assess_input 同时完成研判和建立 handle，原始事实只保存一份。一个 Input 只有一条研判完成记录，可以交给多个 Task / Routine 办理；每个 Work 按 UID 拥有自己的记录。并发 assess_input 只有一个完成事务成功，后续调用返回已有完成事实，不覆盖摘要或追加另一组 Work 请求。

request 支持 context、update、pause、resume、answer；交接说明 note 与原文分开保存，update 的 changes 包含 title、instruction、trigger。Source 观察只能提供 context，不能作为控制授权。已有 handle 的请求不可替换；后来的独立请求必须有新 Input 身份。

`request_work({ workId, text, action?, changes? })` 用于 Chief 独立形成的新请求，创建 origin=chief 的新 Input，按工具调用身份去重，直接建立目标 handle。针对已收到 Input 的交接使用 assess_input，避免复制原始消息。

Task / Routine Watch Input.handle 并按自身 UID 索引读取未完成记录。Reconcile 原子应用确定性请求并记录 appliedAt；暂停或拒绝请求可直接完成，其余材料必须由执行确认。Task / Routine 的后续输入通过原生 followUp / steer 进入当前 invocation，分别经 report_task / report_routine 独立确认。原始 Input 不复制到 spec。

暂停、结果未知的工作可吸收事实但不因此恢复。显式更新可为已完成目标提出新的要求；失败请求保存 rejected 原因而不阻塞后续输入。目标删除会把剩余 handle 标为 cancelled。

### 归属与 Chief 通知

Input 由 Route 确定初始 Topic，Chief 可在树内调整当前归属。明确规则允许直接绑定子 Topic；无规则时 Route 只选择当前 root。Weave 不迁移绑定或研判记录。

root Chief 直接通过 `assessReadyAttention` 按 status.assess.topic、来源优先级与 attention 分页查询未接纳待办，不遍历责任树。`status.topic` 仍供材料检索、归集和容量判断；`assessPending` 保留直属材料未完成索引，`assignedPending` 查询分派给某个 Chief 的未完成研判。

初始 prompt、steer 和 followUp 在发送前，用同一资源事务检查当前 Topic 的版本与 execution，并写入 `Input.status.assess.executionId`、`startedAt`。executionId 指向实际 Chief 执行，不是接收 Reconcile 的执行。竞争失败者重读后忽略已接纳的 Input；初始批次有冲突时整批回滚，下一轮重新选择剩余 Input 并生成 prompt。接纳之后仍可被其它 Topic 的 Chief 主动读取为材料，但不会再次自动提交。Deferred 在被选入已激活 Chief 的批次之前不占接纳标记，主动读取也不占标记；直接完成研判则阻止后续自动提交。

明确未接收的 steer / followUp 可以撤回本次接纳；撤回前再次检查 executionId 与未完成状态。超时、断连和进程中断保留标记及异常，不自动重放。接纳与外部调用不是同一个事务，因此保证的是至多一次自动提交，不保证必达：标记成功后、发送前崩溃也需要核对。`assessExecution` 让执行结束或重启恢复按执行 ID 找到未完成 Input，归组后也能留下异常证据。

原生会话引用 `agent` 用于观测，去重只依赖 executionId。`completedBy` 记录确认完成的工具调用，可以来自后来核对效果的执行，且不会改写原来的接纳身份。Web / Lark 展示优先关联完成工具的 executionId，未记录完成工具时才回退到接纳 executionId。接纳、研判完成、Work 完成和 Output 送达是独立事实。版本边界见 [Resource](../plugin/resource.md#api-版本与演进)。

`tests/input-admission.test.ts` 覆盖跨 root 竞争、初始 prompt 与 followUp 竞争、批次重选、明确拒绝、未知结果保留、重启恢复和归组后按树查询材料。

## 读取、展示与保留

### 上下文预览

自动送入 Route / Chief / Task / Routine 的预览保留正文、来源与身份信息，不展开 observation；有证据时附上 read_input 入口说明，正文超预算时明确提示截断。原始证据和完整正文仍由 InputPrinter.describe 提供，Web 与按需读取不丢失信息。预览减少每轮重复携带的材料，不改变输入的路由、处理确认或保留策略。

### 查询、保留与展示

待办事实保存在 Input.status。Definition.indexes 为 routePending、topic / assessPending / assignedPending / assessReadyAttention / assessExecution、handle / handlePending 提供按阶段和资源 UID 的查询，消费方按索引读取。索引与资源更新在同一事务提交，机制见 [Resource](../plugin/resource.md#索引)。

全部阶段完成后 Input 才可进入容量回收候选；Source 的未提交引用仍可保护它。目标删除明确取消剩余阶段。处理痕迹随 Input 保留，入站去重回执有独立的有界窗口；窗口内重投不会让已回收输入重新执行。用户核对后重新交办是新的 Input。

InputPrinter 同步处理资源快照，describe 保留正文、来源、人物关系与 observation，summarize 生成有界单行预览。Web 和 Agent 读取同一事实表达，打印不会查询外部上下文或调用模型。全文按需分页读取，预览预算不等于模型上下文窗口。

### Web 检索与处理 Timeline

Web 的 Inputs 页查询 Personal 全局 v1 目录中的保留输入，包括尚未路由和静默处理的输入。Connector 从已持久化的来源地址或观察事实识别，来源类型使用 origin / originId，具体观察源使用 originRef 的 UID；删除或停用 Source 不会抹去已有输入的来源选项。正文检索、状态条件与来源条件均在分页前应用。

处理 Timeline 读取同一 Input 的 route / assess / handle。分派、最近记录的执行开始、请求应用、完成回执分别展示；目标实例不存在时保留记录但不链接同名新实例。处理完成要求 route 和所有已分派消费者都完成，不以 Output、原生执行结束或 Work 的当前状态代替。

Output 只在其 inputIds 显式包含当前 Input 时关联，不按相邻顺序、相同 executionId 或相似正文推断。Output 的创建与投递是独立事实；没有关联 Output 也可以是正常的静默处理。

现有 Input status 并非逐次追加的审计日志；重复执行可能只保留最近的 startedAt / executionId 和异常信息。界面展示路由尝试次数与计划重试时间，异常没有独立时间戳时明确显示时间未记录，不能伪装成完整历史。重启后仍可读取保留的回执与 Output，Input 被容量回收后详情返回不存在。

## 验证

`tests/route.test.ts` 覆盖原子分派与重试；`tests/input-assessment.test.ts` 覆盖研判、办理交接和释放；`tests/work-context.test.ts` 覆盖精确确认与事务回滚；`tests/topic-intake.test.ts` 覆盖接收与重投。

`tests/input-browse.test.ts` 覆盖筛选后分页、来源选项、稳定排序、消费回执终态、独立 Work 消费者、已删除目标、明确 Output 关联及 HTTP 页面与查询。

[状态测试](../../tests/status.test.ts)覆盖条件转换、版本冲突与事务回滚。

## 挂载、分派与执行

Input v1alpha6 使用 AddressRef 保存来源位置，并将内容归属和处理分派分开，披露分类统一放在 Note。Input 通过 sender 表示发言人，通过 source 表示场合，不声明 receivers。

1. 挂载：明确定位或 Route 分类写入 status.topic（topic1），保留首次 route 回执。
2. 分派：沿 topic1 的 parent 链找到当前 root，写入 status.assess.topic（topic2）。Route 完成后立即尝试确定性分派；独立 Input Reconcile 恢复中断、处理后续归属变化，不调用模型；直接交给 Routine 的订阅事件没有 assess 阶段，不因此额外触发 Chief。
3. 执行：唤醒 topic2，按分派索引有界选择待办；事务领取 executionId 后才向 Chief 投递，完成后保留 completedAt/result。

`status.topic` 是归属事实，沿 parent 链计算当前 root 的成本为 O(h)。未领取 Input 的 `assess.topic` 是最终一致的负责人缓存，也是 root 查询待办的索引键。Input Reconcile 在缓存为空或与真实 root 不同时修正；领取事务沿真实祖先链校验，拒绝过期负责人并持久化缓存失效，随后重新分派。

每个 Topic 的接收 Reconcile 在固定周期及启动时检查祖先 UID/generation 指纹，发现变化后持久化 `assignmentRefresh`，通过 live 分页每轮最多检查 40 条直属未领取 Input，清空负责人后保存游标。指纹包含祖先 generation，连续移走又移回也会重新检查；中途再发生结构变化就按新指纹重开刷新。每个后代独立检查当前祖先链，不在 Watch 中执行子树扫描或一次性广播。parentRef/generation 本身是持久化的变化事实，漏掉通知也会由周期检查发现。

刷新进度使用 Topic CAS，失败页面可以重复；已领取和已完成 Input 排除在刷新集合之外。缓存清空触发 Input Watch，Topic 每轮也按直属 unassigned 索引修复最多 40 条缺失缓存，覆盖通知丢失。普通材料移动将挂载变化与未领取缓存失效一起提交；这样在 live 游标之前移入的待办也可通过 unassigned 索引恢复。分派收敛的及时性受 Topic 协调周期和待办规模影响。

`executionId / completedAt` 是处理事实。领取后保留实际接纳 Topic，结构变化不改写其负责人或执行记录，旧执行按原 executionId 收尾；新 root 不再自动领取。结果未知保留接纳身份，明确拒绝投递才可撤回该次领取。已处理材料下沉不重新研判，现有树内材料移动仍要求在途研判先完成。

验证：tests/input-assignment.test.ts 覆盖分派恢复、祖先换 root 与移回、分批刷新中断恢复、缓存失效 Watch 与周期补偿、事务拒绝过期分派、旧执行收尾、直属容量和无树扫描的待办查询。

### 输入事件身份

`spec.inputKey?: string` 是 producer 提供的不透明事件键，与话题关联 `topicKey` 和资源身份 `metadata.uid` 分开。提供时必须在 Personal 全局接纳范围内唯一，同一事件重试或经不同入口发现时必须稳定一致。InputStore 只按完整字符串比较，并派生稳定资源名，不解析平台字段；未提供时沿用资源名、owner 与内容的既有幂等检查。

同一条 Lark 消息通过 Channel、不同 app 的 MessageSource 或多个观察账号被发现时，只接纳一个 Input。两个入口共用 Lark 接入层的字符串 key 生成函数，消息身份使用平台 `chatId + messageId`，不包含入口、appId、观察人或正文；同样的正文在不同发送中仍是不同 Input。Channel 和 Source 共用此身份及持久去重回执，入站在资源事务中接纳，重启和容量回收后的重投沿用原回执窗口。

Channel 是直接请求的接纳入口。若 Source 先发现消息，后到的 Channel 在原 Input 上接纳其直接请求事实，更新正文、人物、Immediate、来源 Address 与回复坐标；保持 Input UID、创建时间、既有 Topic 归属和所有处理回执。该单向接纳是 Input 内容不可变约束的唯一消息入口例外，之后的 Source 观察和 Channel 重投均不改写事实，不重新触发已经领取或完成的处理。接纳更正不自动补发已产生的 Output，也不重放外部动作。讨论批次包含新的消息事实，不能用锚点原消息把它当作重复请求吞掉。
