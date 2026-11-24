# Chief：输入处理、判断与记忆

## 整体定位

Chief 是 Aide 在领域 root 上处理 Input／Batch 的角色：结合上下文快速判断，当轮能处理的问题直接回答或调用工具完成；需要独立推进、等待和跟踪的事情，优先关联已有 Work，再按需要创建 Task 或 Routine。分流依据是是否需要独立的工作生命周期，复杂度只是参考，调用工具不必先创建工作。

Route 将用户消息或外部观察归入话题后，Chief 结合话题中的 Work 判断下一步；Secretary 根据处理事实与压力准备回顾等维护 Input。输入分配到 Topic、Task 或 Routine，本质是让一件事进入能解释它、承接它的上下文，具体模型见 [Personal 的主动性与上下文](README.md#主动性与上下文)。Chief 可直接处理、创建或删除工作，或通过 `assess_input` 向已有 Work 交接输入；Work Reconcile 决定如何改变状态与推进。需要用户决定时询问，没有值得打扰的新情况时保持安静。Chief 的判断质量，尤其是提示词、上下文组织与记忆机制，是 Personal Agent 的持续优化重点。

Chief 使用独立的 `chief` Harness 身份，Agent 位于 `plugins/personal/chief/agent/`；它组合 [通用 Pi](../harness/pi.md)，复用 PiAdapter 的执行与事件机制。通用边界见 [Harness](../harness/README.md)，工作生命周期与问答编排见 [Personal](README.md)。

Chief 没有独立 CRD；持久状态由 [Topic.spec/status](topic.md#crd) 承载，接纳和执行由 Chief Reconciler 负责，后续维护的安排由 [Secretary](secretary.md) 负责。

## Reconciler

### 接纳与连续执行

Chief 从当前 root 的已准备待办中选择独立 Input 或 Batch；一个 Batch 对 Chief 是一项工作。Secretary 负责何时生成维护 Input 和 Deferred Batch，Chief 负责当前待办如何执行。

Chief 的接收 Reconcile 先按祖先指纹分批刷新直属待办的负责人缓存、补齐缺失分派，再分别查询独立 Input 的负责人索引和 Batch 的就绪索引，具名 agent Reconcile 驱动 root Chief。Immediate / Normal 在空闲时 prompt，运行中分别使用 steer / followUp；Deferred 由 Secretary 聚合提级后按 Normal 激活；内部维护不消费业务回执。

Input.assess 保存全局唯一研判和 Chief 接纳 executionId。Chief Reconcile 在 prompt / steer / followUp 之前，通过资源事务竞争 Input 接纳；已有接纳或已完成则忽略。Topic 不保存逐条 Input 的通知进度，仍保存 execution、agent 与 Weave 通知版本。assess_input 原子完成唯一研判及 Work 交接，主动读取材料不会重新接纳；后续核对可以提交完成证据。未知投递结果保留当前执行占用；执行结束后，未完成条目释放占用并等待重试。完整查询、并发和恢复契约见 [Input](input.md#归属与-chief-通知)。

明确拒绝 steer / followUp 时恢复待通知状态。status.agent 保存 harness 和原生 sessionId，恢复由 SDK 承担。旧 Chief 自然结束后再释放成为子节点的原生句柄，不修改历史。

root 按 Immediate → 已准备的 Deferred Batch → Normal → aide:organize → aide:followup → aide:curate → aide:summary 选择。Secretary 可在业务执行期间准备维护 Input；维护请求保持独立。Deferred 组批策略见 [Secretary](secretary.md#deferred-归组)，成员及准备契约见 [Batch](batch.md)。

维护只接纳本轮内部 Input，不消费业务回执。Immediate 可在维护期间 steer 同一 Chief，下一模型轮次切换工具；其它准备好的待办通过 followUp 排队，在实际取出时切换任务范围。工具与共享 session 的取舍见 [按 Input 选择工具](#按-input-选择工具)。运行中的 Batch 使用一个 deliveryId、一个原生消息和自身的接纳回执；成员通过 batchId 查询执行事实。

普通待办查询按明确负责人索引，不发现责任树。处理当前任务时，按需工具可读取责任子树内的知识；待办查询边界不限制知识读取。

### 完成与重试

Chief 通过 `assess_input` 持久化结果。成功写入终态即完成；写入失败或执行结束仍无终态时，释放占用后重试原 Input／Batch。完成回执、Chief 工作量和 Review 覆盖水位在同一事务中提交。每个成功 Input／Batch 计一次，包含内部维护，Batch 成员投影不重复计数。计数如何触发新 Review 见 [Secretary](secretary.md#工作量与时间窗口)。

Chief 不为 Secretary 增加结果确认阶段。Batch 的终态由 Input Reconcile 投影到成员；Work 办理和 Output 投递继续遵循各自的完成契约。失败恢复见 [Input](input.md#归属与-chief-通知) 和 [Batch](batch.md)。

### 会话释放

Chief 按 `plugins.personal.topic.idleMs` 释放静默的原生会话，保留 Topic 的认识和树结构。删除或由 root 变为 child 时，关闭旧会话；运行中的旧执行先完成再交接。Gate 保留自己的对话身份，不参与领域静默回收。Topic 的淘汰资格与删除事务见 [Topic 生命周期](topic.md#生命周期)。

## Agent

### 与 Reconciler 的协作

Chief Agent 负责判断，Personal Route 负责话题归位。Chief 的接收 Controller 与 agent Controller 分别通知新材料和调用 Chief；assess_input 确认一项输入的全部材料，say 保存独立 Output。Task / Routine 的持久状态与 Reconcile 仍属于 Personal。

所有 Topic 共用 Chief 配置。Chief 的 Host session 工厂根据调用 scope 的 ResourceRef 校验 Topic UID，装配限定该会话范围的 WorkService 与工具。工具每次执行都重新确认当前 execution，不捕获过期 verbs。

原生会话由 Pi SDK 管理持久化；Chief scope 使用 Topic UID，防止同名重建后恢复旧会话。Operator 在 status.agent 保存配置名和 sessionId，后续原样传给 Harness verb；底座不读写这个字段。用户通过 say 收到问题，后续答复以新的 Input 进入。空闲时 prompt，运行中普通输入 followUp、紧急输入 steer；一个 invocation 可以处理多个 Input，assess_input 的业务回执分别确认完成。

### 按 Input 选择工具

同一 root 的业务响应、回顾与整理共用一个 Chief 和一个原生 session。每个 Chief 工具在定义旁声明 `inputOrigins`，装配层依据当前 Input.origin 选择工具；Input.attention 独立决定调度紧迫性。不增加 mode 字段，也不维护 Respond / Review 等独立工具集合。共享工具声明全部 origin；原生 Pi 与 Hermes 工具的支持范围由 Chief 装配层声明，通用 Pi 不认识 Personal 的 Input。

这样每次模型请求只暴露当前任务需要的工具，减少无关选择，让 LLM 更聚焦。切换时同时投影当前 origin、任务指令与已接纳 Input，明确此前维护任务仍是背景，不能继续使用旧工具或替它确认完成。执行前再次校验当前 execution、工具范围及 assess_input 的目标。

| Input.origin | 任务专属能力（此外共享读取、检索和 upsert_note） |
| --- | --- |
| channel / source / chief | say、cite_output、Work 创建和请求、文件与 CLI 操作；assess_input 可原子交接业务 Input |
| aide:followup | 跟进需要回应的事项。按 episodic Note 保存的时间核实指定问题，或复核事项是否仍需回应。有证据就记录结论，缺少决定性信息就通过 ask_me 私下询问 Me |
| aide:curate | 普通 Note 回顾与归位、Topic 回收许可、Hermes memory/skill 写入 |
| aide:organize | 创建或移动 Topic，归位 Input、Work 和 Note。跨 Topic 的 Note 先写目标再削减或退役来源。|
| aide:summary | 复核指定 Topic、Person 或 Address 的默认认识，按需修订其摘要 |

同一批次可以包含工具能力相同的业务 Input；维护 Input 独立接纳，不与业务取工具并集。业务 Input 优先于内部维护，Immediate 可通过 steer 在下一次安全模型请求边界接入；已经开始的模型调用或工具不会被瞬间撤销。运行中仅 Immediate 使用 steer，其他可投递 Input 始终使用 followUp，业务和内部维护遵循同一规则；工具范围在 Pi 实际取出 followUp 开始处理时切换，排队本身不会打断当前任务。FollowUp 每次取一条，不同 origin 不合并工具列表。未确认完成的 Input 在执行结束后释放占用，记录可重试错误，等待角色 trigger 间隔后继续；已有终态结果保持不变。

Pi 的 `setActiveToolsByName` 替换可用工具，Chief 在首轮 prompt 前初始化，在后续模型轮次准备时更新。Pi 负责生成下一请求的工具声明；当前任务指令通过不持久化的 context projection 注入，原生历史继续共享。日志记录 executionId、origin、Input IDs、实际工具名与数量。

另一种选择是每类任务一个 Agent，各自有工具与 session。它能直接分隔工具，但多个 Agent 写同一 Topic tree 需要 root Reconcile 协调；互斥会让 Immediate 等待维护结束，独立 session 还需补传上下文。单 Chief 复用串行 loop，避免这组 Agent 之间的并行写入与上下文交接；Note、Topic 的版本和事务校验仍处理 Web、Work、Weave 等其他写入方的竞争。

### 主动判断与沟通

Chief 持续关注用户已交付的目标，并发现与这些目标相关的新情况。每次输入到来时，先结合已有 Work、最新外部事实与相关记忆判断：是否属于已有委托，是否具备继续推进的条件，是否需要用户参与。定时 trigger 提供 Reconcile 检查机会，Source 提供外部变化；触发本身不要求生成消息或新建工作。

- **推进已有委托。** 在用户交付的目标和约定内继续处理，保持关联工作的身份与进度；发现条件变化时重新核对下一步。
- **提出新机会。** 说明发现了什么、与用户有什么关系以及建议下一步做什么。记忆中的偏好和兴趣帮助判断相关性，不自动成为新的执行委托。
- **告知进展。** 有值得知道的结果、变化或阻塞时使用普通回复，显式调用 say 工具，经应用的 say action 持久化为 Output，再由投递器发送。相关的低紧迫性信息可以合并说明。
- **请求决定。** 缺少必要信息或用户决定时用 say 提问并结束当前调用；带上已查明的事实、选择与影响，让用户能够直接作出决定。
- **保持安静。** 没有新的依据或可推进事项时静默结束。不重复发送同一进展，也不反复提出尚无新依据或用户回应的建议。

沟通应帮助用户了解结果或作出决定。可自行调查的信息先调查，已经明确交付的工作持续跟进，提问聚焦真正缺少的判断。质量以用户是否少催进度、少重复背景、少纠正操作衡量，具体场景见 [持续委托验收](../e2e.md#持续委托与主动沟通)。

### 提示词与工具

各 Personal Agent 共用 `plugins/personal/execution/agent/identity.ts` 的助理身份与归属规则，遵守 [身份边界](../kernel.md#助理定位与身份边界)。Me 上下文明确人物和渠道身份；已知 Aide 渠道身份随入站证据提供。摘要工具保留作者和确认状态，工作交接区分已有授权、目标与背景建议；这些语义判断由 Agent 完成，不把提示词或版本校验当作归属正确性的确定性证明。

当前稳定角色规则在 `plugins/personal/chief/agent/agent.ts`，包括自然接话、按需创建工作、先检查关联工作、依据工具结果报告操作，以及对外部内容的处理原则。`plugins/personal/chief/reconcile.ts` 组装运行提示，补充 Source 判断约定、当前时间、输入与近期消息；后续回答同样作为普通 Input 接纳。

Chief 注册以下业务工具，并按上述 Input 范围向每次模型请求暴露：

- Work 工具读取、创建、更新与删除绑定会话的 Task / Routine，具体契约见 [输入交接](input.md#研判与办理)、[Task](task.md) 与 [Routine](routine.md)。
- read_input 按页读取会话关联的 Input 原文与证据，补足大输入的预览。
- say 产生独立 Output；答复是新的 Input，不挂起 Harness 等待。
- Connector 工具使用 Host 的全局目录，查询需求、PR、评论和环境声明。`list_environments` 列举环境，`read_environment` 按名称或别名返回规范身份与访问坐标；这些声明不代表连通性或健康状态。
- 对固定成员组成的输入只调用一次 assess_input，成员研判回执由 Input Reconcile 投影；可按原成员身份交办 Work，不能把整批完成等同于 Work 完成。
- assess_input 原子保存独立 Input 的简短研判回执，并建立 Work handle；不改写 Topic.summary / recent，不值得通知的观察可以静默完成。
- list_notes 查询 recent 之外仍保留的具体事项；move_note 在责任树内调整事项归属，保留内容与年龄；超出数量或篇幅软预算时使用 upsert_note 整合信息，用 split_note 原子拆出新篇，合并到已有目标时确认保存后用 prune_note 削减来源，或用 retire_note 退役无独立价值的整篇 Note。
- Chief 通过 upsert_note 记录近期事项。维护 Input 可以用同一工具修订摘要，只有认识或职责范围变化时才需要写入。

提示词表达判断策略，工具边界保证持久化与会话范围。say 提问只产生 Output；用户是否回答不阻塞其它输入，已有 Work 的 waiting 状态表达具体工作的等待。

### Context View

下面的“上下文组织与优化”是 prompt 文本大纲：system 是固定身份、职责与规则；user 由 Me 与 Topic 当前背景、本轮 Input 或维护请求组成。原生对话和工具回执由 Harness 管理。

#### 上下文组织与优化

Chief 的直接回答、研判和工作交接都依赖当前话题与已有委托。当前按以下消息结构组织上下文；业务前缀的刷新与消息机制见 [Route 上下文组织](route.md#上下文组织与优化)。

Chief 的话题材料由 [Topic Background](../../plugins/personal/chief/agent/background.ts) 提供，包含当前会话的 summary、recent 和相关 Work；Chief 装配时再结合最新 Me 认识，形成最终 `Background`。每次模型请求前通过 `background()` 构造快照，Harness 调用 `text()` 生成 custom → user 前缀。读取最新资源与文本化快照分开，通用契约见 [Pi 当前业务背景](../harness/pi.md#当前业务背景)。

```text
system：Chief 的固定职责、沟通规则和授权边界
custom → user：Background.text()，当前业务背景 v1
  topic：当前话题 summary、有限 recent
  work：所属 Topic 的 Task / Routine UID、目标和状态
  me：服务对象的当前认识与明确修正
user：Input 1
assistant / tool：按需直接处理或 say，assess_input 确认研判
user：Input 2                         # 状态没变，保持相同背景前缀
assistant / tool：处理与回执
后续请求的 custom → user 前缀：变化部分替换为 v2
  work：已有 Task 的新进展；其它背景不变
user：Input 3
assistant / tool：结合新进展回答或交接，避免重复创建工作
```

当前状态从 CRD 投影为请求前缀，不追加进历史，也不参与历史压缩；重启后重新读取。自动输入预览保留内容、人物和地址，完整 observation 留在 Input，通过 read_input 按需读取；不要例行展开所有证据。工具回执和对话作为执行历史，由 Pi 管理压缩；Person 与 Topic 的 summary 仍由各自资源维护。用户修正、Work 状态与外部事实不能被历史摘要覆盖，状态内容也不扩大操作权限。

常驻 summary 最多预览 8000 字符，普通 Note 使用独立数量与字符预算的名称目录，按 ID 读取正文；所属会话的 Work 列表按 20 项和约 16000 个 JSON 字符分页。省略信息通过读取工具补查，完整认识仍保存在资源中。

效果优化优先检查模型是否看到了最新委托、是否重复查询或重复建 Work、是否为简单回答装入了过多材料。调整背景内容、刷新时机、Input 预览与按需读取边界，并结合回答准确性、提醒价值、上下文 token 和缓存表现验证；不靠不断叠加提示词弥补过期或重复上下文。

### 上下文与记忆

root Chief 可维护来源 Topic 的局部认识和 root 的综合认识。子节点没有独立 Chief，局部 summary 仍由当前 root Chief 维护。assess 保存单次处理事实，summary 仅在长期认识变化时修订；近期事项按同一事项维护 Note。静默处理一条 Input 不要求修订认识。

原生会话通过 Harness 支持的方式初始化、持久化与恢复。新父 Topic 的 Chief 读取子主题认识，不拼接、改写子 Chief 的原生会话文件，不重放已完成 Input。模型请求前的业务背景使用 [Background](../harness/pi.md#当前业务背景) 通道；完整的知识维护和回收约束见 [Topic](topic.md#主题认识与汇总)。

Aide 组合开源产品的通用记忆能力。Chief 内置固定版本的 [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory)，由 Pi 的扩展加载器显式加载。
事项认识由 Note 承载，主题、人物、场合和工作的长期认识由各自 summary 承载，Topic tree 保存主题组织关系；Hermes 提供通用记忆与检索。职责与沉淀主线见 [Personal](README.md#从-input-到认识与成果)。

Chief 处理 `aide:summary` 时通读所选对象的摘要及相关证据。Person 与 Address 的认识可以来自多个领域；修订时保留其他领域仍然有效的内容和用户修正，遇到版本冲突重新读取。各对象的内容职责见 [作为 summary 的 Note](note.md#作为-summary-的-note)。

#### 人物认知

Chief 每轮读取共享目录中的 Me，将姓名、用户明确修正和精简后的当前认识放入上下文。其它人物通过 list_persons / read_person 按需查询；工具读取完整资料和最新版本。Topic 背景中的[近期相关人物](chief.md#近期相关人物)只提供引用与名称，供 Chief 发现需要进一步读取的人物，不自动携带所有人的认识。

read_person 提供人物摘要 Note 的 id 和 version，供 aide:summary 按需修订。近期计划、交往和参与事项通过统一 upsert_note 的 people 关联 Person，保留实际作者和确认状态，不从他人的表达推断本人意图。详见[有界认识与近期依据](README.md#有界认识与近期依据)。
工具只更新人物认识，无法改写外部身份或 Me 标记。用户修正直接保存到同一个 summary，Chief 继续维护时应保留其含义。发生版本冲突时重新读取并合并；Web 编辑与其它会话更新在下一轮可见。用户的明确修正优先于历史推断和 Hermes 记忆。

sent 提供本人表达的线索，仍需辨别引用与代发；received 和 observed 不代表本人认可或授权。混合讨论逐条核对作者。人物认知用于理解和服务，不产生新的执行委托，也不向其它聊天参与者披露私密画像。

人物资料的唯一存储来源是 Person CRD，Web Persons 提供编辑入口。人物维护使用专用工具，普通文件工具和 Hermes 不承担这份资料的维护。

连续上下文由 Pi SDK 管理历史、压缩与恢复。新输入只提供本次预览，普通输入 followup，immediate 使用 steer。assess_input 只在 Input 保存简短研判回执；upsert_note 在维护 Input 中按需修订话题认识。常规静默观察不复制进 summary、recent 或长期记忆，持续事项通过同一 Note 维护，恶化或恢复时更新；主题、人物与工作的长期认识通过各自 summary 维护，Task / Routine 保存工作状态。原生会话或调用结束不能代替业务确认。

Hermes 提供 `memory_add`、`memory_replace`、`memory_remove`、`memory_search`、`session_search` 等工具。默认 policy-only 模式注入使用策略，按需检索记忆；固定用户要求、后台学习、纠错捕获、压缩前和退出时整理均沿用扩展自己的实现与配置。Topic summary 承载主题的长期认识，并作为判断新输入的背景；Hermes 的记忆与检索由扩展维护。Personal 通过 Harness 调用 Agent，由 Agent 使用相应工具维护认识。

#### 记忆如何参与判断

记忆提供可复用的用户偏好、背景事实和执行经验，帮助 Chief 理解输入、关联工作和减少重复询问。工作是否完成、某个动作是否已经生效，应读取 Work、执行记录或外部系统。与最新事实冲突时先核对来源，纠正过期信息；不能用记忆中的印象覆盖业务事实。

Chief 使用上游记忆工具维护有长期价值的信息，保留足以理解其来源与适用范围的上下文，并响应用户的纠正和删除要求。临时猜测不直接作为稳定事实使用。记忆能力的选型与效果优化属于 Chief Harness，Personal 继续通过相同的 Harness 契约调用它。

#### 存储与配置

默认根目录是 `~/.pi/agent`，Hermes 在模块加载时读取进程级 `PI_CODING_AGENT_DIR`，可用它切换根目录。只修改工厂的 `agentDir` 不会改变 Hermes 的目录；需要在启动 Aide 前设置环境变量，不能按会话修改进程环境。

```text
~/.pi/agent/
├── hermes-memory-config.json       # Hermes 原生配置
├── pi-hermes-memory/
│   ├── MEMORY.md                   # 长期事实的 Markdown 存储/导出
│   ├── USER.md                     # 用户画像
│   ├── STANDING.md                 # 用户明确固定的要求
│   ├── sessions.db                 # SQLite 记忆与会话检索
│   └── skills/                     # 扩展维护的技能
├── projects-memory/<project>/      # Hermes 按工作目录识别的项目记忆
└── sessions/                       # Pi 原生会话
```

`hermes-memory-config.json` 中的 `memoryDir` 可单独更改全局记忆目录；其它选项和文件由 [上游配置文档](https://github.com/chandra447/pi-hermes-memory#configuration) 定义。依赖随 `npm install` 安装，不需要另运行 `pi install` 或 `aide sync`。

此处全局记忆由同一进程根目录下的 Chief 共享，项目记忆按 Hermes 的 cwd 规则划分，**不按 Aide Session 或 Topic 隔离**。不同群的原生对话上下文仍独立，但扩展的长期记忆和会话检索可能跨会话使用。不要把 Topic 分组理解为记忆访问边界。

#### 扩展生命周期

PiAdapter 在 open 时绑定无 TUI 的扩展运行环境并触发 `session_start`；Pi 在执行中驱动提示词、工具和压缩钩子；close 先取消正在执行的调用，再等待 `session_shutdown`，最后 dispose 原生会话。这样 Hermes 能完成整理与数据库清理。扩展加载或启动失败会阻止本次 Harness open，并记录错误；运行期钩子错误通过 `pi.extension` 日志报告。

自动学习和压缩/退出整理可能产生额外模型调用与等待，遵循 Hermes 自己的策略、期限和失败处理。这些内部维护调用不作为 Personal Work 或独立 Aide HarnessInvocation 展示。

### 与 Route 的协作

输入分派契约见 [Route](route.md)。Chief 可以研判当前 Topic 子树的材料并按需交给 Work；Route 与 Chief 隔离原生上下文，共用 Hermes 长期记忆，Route 只检索、Chief 可以维护。Default 的 Chief 按普通话题规则判断，不因兜底身份获得额外授权。

### 近期相关人物

近期事项保存为独立 Note CRD，`spec.subject` 关联 Topic / Task / Routine，`spec.people` 关联人物。省略 people 保留已有引用，[] 清空；历史人物可悬空。完整契约见 [Note](note.md)。

上下文里的 persons 从当前 Topic 自身 Note 查询窗口中按 UID 去重，最多预览 8 人，返回 source=recentNotes、Note 数和省略人数；不回查 Input 或递归汇总子树。父 Topic 不复制子 Note。人物删除或重建时显示 unavailable，不展开私密资料。

Route、Chief、Weave 的列表在确定范围、排序和 offset 后，逐条补充活动、人物名称等派生信息，达到条数或字符预算即停止，最多多计算一条因字符预算放不下的候选；nextOffset 指向未返回的下一条。人物名称采用只读投影，不刷新 Person 的访问时间，不开启写事务。Note 自动预览同样最多携带 8 个引用，超出部分以 peopleOmitted 标明，完整引用保留在 Note 中并可分页读取。完整 Topic 读取只解析所选 Topic 的人物。

`catalogFingerprint` 根据已加载的 Topic UID、名称、组织调整依据、认识版本和最近 Input 时间计算，覆盖目录顺序、名称、组织调整依据及已记录的认识；`fingerprint` 根据本页实际返回内容计算。目录指纹不为未展示项查询活动、人物名称，也不承诺这些派生数据仍然有效，依赖详情前重新读取相关页面。

共同人物仅是语义关联的参考，结合名称、summary、近期活动与组织调整原因判断；不按人物交集阈值自动归组，也不以缺少交集否定关联。Me 的广泛出现尤其不能充当归组理由。人物关联变化保留在 Note 内容版本中，后续整理或定时回顾时按需纳入判断。验证见 `tests/topic-persons.test.ts`。

### 研判与上下文

assess_input 保存单次研判回执并原子交接 Work。维护 Input 用 upsert_note 的 Note 版本修订长期认识，提交时校验版本、当前执行与真实归属。upsert_note 默认当前 Topic，可指定子树中的 subject，通过 people 关联人物；不同 Note 不互相锁住。完整规则见 [Note](note.md)。

list_topics 提供摘要预览和普通 Note 名称目录，`notes.total` 表示活跃普通 Note 总数。read_topic 返回对象认识与目录，`nextOffset` 非空时继续读取；Note 正文通过 read_note 按 ID 获取，目录以外的发现使用 list_notes。变更摘要前读取相关的完整证据。

maxChars 默认 4000，是普通 Note 与 summary Note 共用的篇幅软预算；单篇存储上限仍为 16000。maxNotes 默认 10，超过直属活跃普通 Note 数量或单篇篇幅预算时，按 [Note 整理](note.md#数量与篇幅驱动的整理) 安排 Chief。contextChars 默认 48000。近期依据仍受统一数量和字符预算约束。详情见[配置](../configuration.md#topic-消费策略)。

## 验证

`tests/pi-agent.test.ts` 使用真实 Pi SDK、Hermes 扩展、临时 Markdown/SQLite 存储和模拟模型，验证 Chief 工具与策略注入、跨全新原生会话写入和召回，以及通用 Pi 不自动获得记忆工具。Adapter 的扩展启动/退出与失败处理也有契约验证。测试关闭扩展的自动模型整理，避免影响脚本化模型请求。

同一测试还验证 Chief 通过真实 Pi 工具调用 read_person，以及续轮、跨会话和用户纠正后的刷新。人物目录与 Web API 的版本、身份和回收边界见 tests/person-catalog.test.ts。
`tests/person.test.ts` 与消息 Source 测试验证身份作用域、机器人与本人区分、关系持久化和混合上下文逐条归因。

现有 Source → Chief → 用户决定 → Work 验证继续覆盖 Personal 装配。以上不能证明真实模型会正确选择值得保存的事实，或后台提炼、压缩后召回的实际质量；这些效果需要真实使用评估。真实 Channel 验收见 [E2E](../e2e.md)。

### 当前发送能力

Chief 通过 `read_person.contacts` 找到联系地址，再由 `read_address.delivery.configured` 核对 Host 的当前发送路径。该值复用 Output 的目标配置检查，不证明平台可达、权限或投递成功，也不覆盖禁言和披露判定。Lark open_id 单聊不要求已经观察到机器人私聊或先拉群；Host Channel 凭证独立于 lark-cli 登录与 shell 配置。历史 Note 的能力判断不能替代当前 Host 查询；实际发信仍经 Output。

Chief Reconcile 只接纳当前可处理的非 Deferred Input／Batch，并按 origin 选择工具与执行路径。完成一次计一项 Chief 工作量，包括内部维护 Input；一个 Batch 始终计一项。维护的生成时机、冷却和退避归 [Secretary](secretary.md)，Chief 完成事务只保存结果与对应水位事实。
