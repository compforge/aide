# Chief：判断、工具与记忆

Chief 是 Aide 面向用户的接话与分流入口，也能直接办事，职责类似 System 1：结合上下文快速判断，当轮能处理的问题直接回答或调用工具完成；需要独立推进、等待和跟踪的事情，优先关联已有 Work，再按需要创建 Task 或 Routine。分流依据是是否需要独立的工作生命周期，复杂度只是参考，调用工具不必先创建工作。

Route 将用户消息或外部观察归入话题后，Chief 结合话题中的 Work 判断下一步；Topic 自身的 trigger 也会触发回顾。输入分配到 Topic、Task 或 Routine，本质是让一件事进入能解释它、承接它的上下文，具体模型见 [Personal 的主动性与上下文](README.md#主动性与上下文)。Chief 可直接处理、创建或删除工作，或通过 `assess_input` 向已有 Work 交接输入；Work Reconcile 决定如何改变状态与推进。需要用户决定时询问，没有值得打扰的新情况时保持安静。Chief 的判断质量，尤其是提示词、上下文组织与记忆机制，是 Personal Agent 的持续优化重点。

Chief 使用独立的 `chief` Harness 身份，Agent 位于 `agents/chief/`；它组合 [通用 Pi](../harness/pi.md)，复用 PiAdapter 的执行与事件机制。通用边界见 [Harness](../harness/README.md)，工作生命周期与问答编排见 [Personal](README.md)。

## Agent 与 Controller

Chief Agent 负责判断，Personal Route 负责话题归位。Topic 的接收 Controller 与 agent Controller 分别通知新材料和调用 Chief；assess_input 确认消费，say 保存独立 Output。Task / Routine 的持久状态与 Reconcile 仍属于 Personal。

所有 Topic 共用 Chief 配置。Personal 的 chiefSession 工厂根据调用 scope 的 ResourceRef 校验 Topic UID，装配限定该会话范围的 WorkService 与工具。工具每次执行都重新确认当前 execution，不捕获过期 verbs。

原生会话由 Pi SDK 管理持久化；Chief scope 使用 Topic UID，防止同名重建后恢复旧会话。Operator 在 status.agent 保存配置名和 sessionId，后续原样传给 Harness verb；底座不读写这个字段。用户通过 say 收到问题，后续答复以新的 Input 进入。空闲时 prompt，运行中普通输入 followUp、紧急输入 steer；一个 invocation 可以处理多个 Input，assess_input 的业务回执分别确认完成。

## 主动判断与沟通

Chief 持续关注用户已交付的目标，并发现与这些目标相关的新情况。每次输入到来时，先结合已有 Work、最新外部事实与相关记忆判断：是否属于已有委托，是否具备继续推进的条件，是否需要用户参与。trigger 提供定时回顾的机会，Source 提供外部变化；触发本身不要求生成消息或新建工作。

- **推进已有委托。** 在用户交付的目标和约定内继续处理，保持关联工作的身份与进度；发现条件变化时重新核对下一步。
- **提出新机会。** 说明发现了什么、与用户有什么关系以及建议下一步做什么。记忆中的偏好和兴趣帮助判断相关性，不自动成为新的执行委托。
- **告知进展。** 有值得知道的结果、变化或阻塞时使用普通回复，显式调用 say 工具，经应用的 say action 持久化为 Output，再由投递器发送。相关的低紧迫性信息可以合并说明。
- **请求决定。** 缺少必要信息或用户决定时用 say 提问并结束当前调用；带上已查明的事实、选择与影响，让用户能够直接作出决定。
- **保持安静。** 没有新的依据或可推进事项时静默结束。不重复发送同一进展，也不反复提出尚无新依据或用户回应的建议。

沟通应帮助用户了解结果或作出决定。可自行调查的信息先调查，已经明确交付的工作持续跟进，提问聚焦真正缺少的判断。质量以用户是否少催进度、少重复背景、少纠正操作衡量，具体场景见 [持续委托验收](../e2e.md#持续委托与主动沟通)。

## 提示词与工具

各 Personal Agent 共用 `agents/personal.ts` 的助理身份与归属规则，遵守 [身份边界](../kernel.md#助理定位与身份边界)。Me 上下文明确人物和渠道身份；已知 Aide 渠道身份随入站证据提供。摘要工具保留作者和确认状态，工作交接区分已有授权、目标与背景建议；这些语义判断由 Agent 完成，不把提示词或版本校验当作归属正确性的确定性证明。

当前稳定角色规则在 `agents/chief/agent.ts`，包括自然接话、按需创建工作、先检查关联工作、依据工具结果报告操作，以及对外部内容的处理原则。`plugins/personal/topic/reconcile.ts` 组装运行提示，补充 Source 判断约定、当前时间、输入与近期消息；后续回答同样作为普通 Input 接纳。

Chief 在 Pi 的文件与 CLI 能力上增加以下业务工具：

- Work 工具读取、创建、更新与删除绑定会话的 Task / Routine，具体契约见 [输入交接](input.md#研判与办理)、[Task](task.md) 与 [Routine](routine.md)。
- read_input 按页读取会话关联的 Input 原文与证据，补足大输入的预览。
- say 产生独立 Output；答复是新的 Input，不挂起 Harness 等待。
- Connector 工具使用 Host 的全局目录，查询需求、PR、评论和环境声明。`list_environments` 列举环境，`read_environment` 按名称或别名返回规范身份与访问坐标；这些声明不代表连通性或健康状态。
- assess_input 原子保存单条 Input 的简短研判回执，并建立 Work handle；不改写 Topic.summary / recent，不值得通知的观察可以静默完成。
- summarize_topic 只修订长期有效、低频变化的认识；只确认子版本时可省略 summary。upsert_note 独立维护近期事项，以同一 noteId 连接多次输入的进展，不要求改写 summary。

提示词表达判断策略，工具边界保证持久化与会话范围。say 提问只产生 Output；用户是否回答不阻塞其它输入，已有 Work 的 waiting 状态表达具体工作的等待。

## 上下文与记忆

Aide 组合开源产品的通用记忆能力。Chief 内置固定版本的 [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory)，由 Pi 的扩展加载器显式加载。
人物认知由 Personal 的 Person CRD 承载，Hermes 提供其它通用记忆与检索。

### 上下文组织与优化

Chief 的直接回答、研判和工作交接都依赖当前话题与已有委托。当前按以下消息结构组织上下文；业务前缀的刷新与消息机制见 [Route 上下文组织](route.md#上下文组织与优化)。

Chief 的话题材料由 [Topic Background](../../plugins/personal/topic/background.ts) 提供，包含当前会话的 summary、recent 和相关 Work；Chief 装配时再结合最新 Me 认识，形成最终 `Background`。每次模型请求前通过 `background()` 构造快照，Harness 调用 `text()` 生成 custom → user 前缀。读取最新资源与文本化快照分开，通用契约见 [Pi 当前业务背景](../harness/pi.md#当前业务背景)。

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

常驻 summary 最多预览 8000 字符，recent 最多 3 条、每条 500 字符；所属会话的 Work 列表按 20 项和约 16000 个 JSON 字符分页。省略信息通过读取工具补查，完整认识仍保存在资源中。

效果优化优先检查模型是否看到了最新委托、是否重复查询或重复建 Work、是否为简单回答装入了过多材料。调整背景内容、刷新时机、Input 预览与按需读取边界，并结合回答准确性、提醒价值、上下文 token 和缓存表现验证；不靠不断叠加提示词弥补过期或重复上下文。

### 人物认知

Chief 每轮读取共享目录中的 Me，将姓名、用户明确修正和精简后的当前认识放入上下文。其它人物通过 list_persons / read_person 按需查询；工具读取完整资料和最新版本。

summarize_person 接受人物 ID、uid、resourceVersion 以及修订后的长期 summary。近期计划、交往和参与事项通过 upsert_note 显式选择 Person 维护，保留实际作者和确认状态，不从他人的表达推断本人意图。详见[有界认识与近期依据](README.md#有界认识与近期依据)。
工具只更新人物认识，无法改写外部身份或 Me 标记。用户修正直接保存到同一个 summary，Chief 继续维护时应保留其含义。发生版本冲突时重新读取并合并；Web 编辑与其它会话更新在下一轮可见。用户的明确修正优先于历史推断和 Hermes 记忆。

sent 提供本人表达的线索，仍需辨别引用与代发；received 和 observed 不代表本人认可或授权。混合讨论逐条核对作者。人物认知用于理解和服务，不产生新的执行委托，也不向其它聊天参与者披露私密画像。

人物资料的唯一存储来源是 Person CRD，Web Persons 提供编辑入口。人物维护使用专用工具，普通文件工具和 Hermes 不承担这份资料的维护。

连续上下文由 Pi SDK 管理历史、压缩与恢复。新输入只提供本次预览，普通输入 followup，immediate 使用 steer。assess_input 只在 Input 保存简短研判回执；summarize_topic 独立维护话题认识。常规静默观察不复制进 summary、recent 或长期记忆，持续事项通过同一 Note 维护，恶化或恢复时更新；长期知识通过 Hermes 保留，Task / Routine 保存工作状态。原生会话或调用结束不能代替业务确认。

Hermes 提供 `memory_add`、`memory_replace`、`memory_remove`、`memory_search`、`session_search` 等工具。默认 policy-only 模式注入使用策略，按需检索记忆；固定用户要求、后台学习、纠错捕获、压缩前和退出时整理均沿用扩展自己的实现与配置。Topic 摘要用于控制话题窗口，与 Hermes 的长期记忆维护分别管理；Personal 不直接调用模型做记忆维护。

### 记忆如何参与判断

记忆提供可复用的用户偏好、背景事实和执行经验，帮助 Chief 理解输入、关联工作和减少重复询问。工作是否完成、某个动作是否已经生效，应读取 Work、执行记录或外部系统。与最新事实冲突时先核对来源，纠正过期信息；不能用记忆中的印象覆盖业务事实。

Chief 使用上游记忆工具维护有长期价值的信息，保留足以理解其来源与适用范围的上下文，并响应用户的纠正和删除要求。临时猜测不直接作为稳定事实使用。记忆能力的选型与效果优化属于 Chief Harness，Personal 继续通过相同的 Harness 契约调用它。

### 存储与配置

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

### 扩展生命周期

PiAdapter 在 open 时绑定无 TUI 的扩展运行环境并触发 `session_start`；Pi 在执行中驱动提示词、工具和压缩钩子；close 先取消正在执行的调用，再等待 `session_shutdown`，最后 dispose 原生会话。这样 Hermes 能完成整理与数据库清理。扩展加载或启动失败会阻止本次 Harness open，并记录错误；运行期钩子错误通过 `pi.extension` 日志报告。

自动学习和压缩/退出整理可能产生额外模型调用与等待，遵循 Hermes 自己的策略、期限和失败处理。这些内部维护调用不作为 Personal Work 或独立 Aide HarnessInvocation 展示。

## 验证

`tests/pi-agent.test.ts` 使用真实 Pi SDK、Hermes 扩展、临时 Markdown/SQLite 存储和模拟模型，验证 Chief 工具与策略注入、跨全新原生会话写入和召回，以及通用 Pi 不自动获得记忆工具。Adapter 的扩展启动/退出与失败处理也有契约验证。测试关闭扩展的自动模型整理，避免影响脚本化模型请求。

同一测试还验证 Chief 通过真实 Pi 工具调用 read_person / summarize_person，以及续轮、跨会话和用户纠正后的刷新。人物目录与 Web API 的版本、身份和回收边界见 tests/person-catalog.test.ts。
`tests/person.test.ts` 与消息 Source 测试验证身份作用域、机器人与本人区分、关系持久化和混合上下文逐条归因。

现有 Source → Chief → 用户决定 → Work 验证继续覆盖 Personal 装配。以上不能证明真实模型会正确选择值得保存的事实，或后台提炼、压缩后召回的实际质量；这些效果需要真实使用评估。真实 Channel 验收见 [E2E](../e2e.md)。

## 与 Route 的协作

输入分派契约见 [Route](route.md)。Chief 可以研判当前 Topic 子树的材料并按需交给 Work；Route 与 Chief 隔离原生上下文，共用 Hermes 长期记忆，Route 只检索、Chief 可以维护。Default 的 Chief 按普通话题规则判断，不因兜底身份获得额外授权。
