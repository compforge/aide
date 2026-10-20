# Chief Harness

Chief 是 Aide 面向用户的接话与分流入口，也能直接办事，职责类似 System 1：结合上下文快速判断，当轮能处理的问题直接回答或调用工具完成；需要独立推进、等待和跟踪的事情，优先关联已有 Work，再按需要创建 Task 或 Routine。分流依据是是否需要独立的工作生命周期，复杂度只是参考，调用工具不必先创建工作。

Chief 先把用户消息或外部观察归入合适的话题，再结合话题中的 Work 判断下一步；Conversation 自身的 trigger 也会触发回顾。输入分配到 Conversation、Task 或 Routine，本质是让一件事进入能解释它、承接它的上下文，具体模型见 [Personal 的主动性与上下文](../plugin/personal.md#主动性与上下文)。Chief 可直接处理、创建或删除工作，或通过 `append_input` 向已有 Work 交接输入；Work Reconcile 决定如何改变状态与推进。需要用户决定时询问，没有值得打扰的新情况时保持安静。Chief 的判断质量，尤其是提示词、上下文组织与记忆机制，是 Personal Agent 的持续优化重点。

Chief 使用独立的 `chief` Harness 身份，Agent 位于 `agents/chief/`；它组合 [通用 Pi](pi.md)，复用 PiAdapter 的执行与事件机制。通用边界见 [Harness](README.md)，工作生命周期与问答编排见 [Personal](../plugin/personal.md)。

## Agent 与 Controller

Chief Agent 拥有 Personal 提示词和工具，负责具体判断。Chief 的 Input Reconcile 负责话题归位；Conversation Reconcile 响应新 Input 与定时回顾，准备上下文、调用 Harness 并续接用户答复。Task / Routine 的持久状态与 Reconcile 属于 Personal，Agent 通过工具访问，不能直接宣告资源完成。

Personal 在所属 Session 内为每个 Conversation 绑定固定 Lane、Chief Target 和 WorkService，并提供问答与 Connector 工具。宿主装配使用 `chiefSession` 工厂；缺少绑定时创建 Chief Harness 会报错，不会降级为通用 Pi。

```ts
const adapter = createHarnessAdapter(
  { id: chiefTargetId, harness: "chief" },
  { ...ports, targetConfig: { harness: "chief" },
    chiefSession: aide.chiefSession(chiefTargetId) },
);
```

Chief 的模型选择与能力包配置位于 `harnesses.chief`，完整来源、优先级和同步流程见 [配置](../configuration.md)。
启动装配解析模型定义、认证来源和能力包，并将有效配置注入 `chiefSession`；Personal 只绑定业务工具。显式 model 覆盖 Pi 定义，缺省规则见配置文档。Task / Routine 按 `defaultHarness` 选择执行实现，使用对应的 Harness 配置。
Chief 加载已同步的声明包中的 skills，以及内置 Hermes 扩展提供的记忆工具与自维护 skills；不继承用户或项目的自动扩展、skill 包发现。角色规则与 Work 工具仍由代码绑定。
原生会话由 Pi SDK 存放在自己的默认目录，与通用 Pi 一样；Chief 角色通过 scope 区分，不靠另建 chief-sessions 目录区分。连续输入复用该 Lane × Target 的原生会话，服务重启后 Core 把保存的 resumeState 交回 Adapter；新的 Input 创建新 Turn。原生恢复范围绑定 conversationId，不能把另一会话或通用 Pi 的会话文件当成当前上下文。

## 主动判断与沟通

Chief 持续关注用户已交付的目标，并发现与这些目标相关的新情况。每次输入到来时，先结合已有 Work、最新外部事实与相关记忆判断：是否属于已有委托，是否具备继续推进的条件，是否需要用户参与。trigger 提供定时回顾的机会，Source 提供外部变化；触发本身不要求生成消息或新建工作。

- **推进已有委托。** 在用户交付的目标和约定内继续处理，保持关联工作的身份与进度；发现条件变化时重新核对下一步。
- **提出新机会。** 说明发现了什么、与用户有什么关系以及建议下一步做什么。记忆中的偏好和兴趣帮助判断相关性，不自动成为新的执行委托。
- **告知进展。** 有值得知道的结果、变化或阻塞时使用普通回复，由 Controller 经 say 投递。相关的低紧迫性信息可以合并说明。
- **请求决定。** 缺少必要信息时 ask，明确动作需要用户决定时 confirm；带上已查明的事实、选择与影响，让用户能够直接作出决定。
- **保持安静。** 没有新的依据或可推进事项时静默结束。不重复发送同一进展，也不反复提出尚无新依据或用户回应的建议。

沟通应帮助用户了解结果或作出决定。可自行调查的信息先调查，已经明确交付的工作持续跟进，提问聚焦真正缺少的判断。质量以用户是否少催进度、少重复背景、少纠正操作衡量，具体场景见 [持续委托验收](../e2e.md#持续委托与主动沟通)。

## 提示词与工具

当前稳定角色规则在 `agents/chief/agent.ts`，包括自然接话、按需创建工作、先检查关联工作、依据工具结果报告操作，以及对外部内容的处理原则。`plugins/personal/conversation/reconcile.ts` 组装运行提示，补充 Source 判断约定、当前时间、输入与近期消息；收到用户答复后构造续轮提示。

Chief 在 Pi 的文件与 CLI 能力上增加以下业务工具：

- Work 工具读取、创建、更新与删除绑定会话的 Task / Routine，具体契约见 [Personal](../plugin/personal.md)。
- ask / confirm 提出问题意图，Controller 在模型 Turn 结束后通过 Core Interaction 等待答复。
- Connector 工具使用 Host 的全局目录，查询需求、PR、评论和环境声明。`list_environments` 列举环境，`read_environment` 按名称或别名返回规范身份与访问坐标；这些声明不代表连通性或健康状态。
- dismiss_observation 保存忽略原因，让不值得通知的 Source 观察静默结束。

提示词表达判断策略，工具边界保证持久化与会话范围。Work 写工具在提出问题后暂停接受修改，直到用户答复进入续轮；这项约束不能只依赖模型记住提示。

## 上下文与记忆

Aide 组合开源产品的记忆能力，不自行实现记忆提取、存储、检索或整理。Chief 内置固定版本的 [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory)，由 Pi 的扩展加载器显式加载。Personal 只调用 Chief Harness，不感知它是否具有记忆，也不提供 Memory Service、资源或工具。

连续输入复用 Conversation 对应的固定 Lane 和原生 Pi 会话；Pi 负责原生历史与压缩，Controller 仍补充当前输入、近期消息与工作回复。长期记忆独立于原生会话，由 Hermes 的工具和生命周期钩子维护，重建原生会话不会清空记忆。Task / Routine 仍是工作状态的权威来源。

Hermes 提供 `memory_add`、`memory_replace`、`memory_remove`、`memory_search`、`session_search` 等工具。默认 policy-only 模式注入使用策略，按需检索记忆；固定用户要求、后台学习、纠错捕获、压缩前和退出时整理均沿用扩展自己的实现与配置。Aide 不另建摘要任务，也不通过 Personal 直接调用模型做记忆维护。

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

此处全局记忆由同一进程根目录下的 Chief 共享，项目记忆按 Hermes 的 cwd 规则划分，**不按 Aide Session 或 Conversation 隔离**。不同群的原生对话上下文仍独立，但扩展的长期记忆和会话检索可能跨会话使用。不要把 Conversation 分组理解为记忆访问边界。

### 扩展生命周期

PiAdapter 在 open 时绑定无 TUI 的扩展运行环境并触发 `session_start`；Pi 在执行中驱动提示词、工具和压缩钩子；close 先取消正在执行的 Turn，再等待 `session_shutdown`，最后 dispose 原生会话。这样 Hermes 能完成整理与数据库清理。扩展加载或启动失败会阻止本次 Harness open，并记录错误；运行期钩子错误通过 `pi.extension` 日志报告。

自动学习和压缩/退出整理可能产生额外模型调用与等待，遵循 Hermes 自己的策略、期限和失败处理。这些内部维护调用不作为 Personal Work 或独立 Aide Turn 展示。

## 验证

`tests/pi-agent.test.ts` 使用真实 Pi SDK、Hermes 扩展、临时 Markdown/SQLite 存储和模拟模型，验证 Chief 工具与策略注入、跨全新原生会话写入和召回，以及通用 Pi 不自动获得记忆工具。Adapter 的扩展启动/退出与失败处理也有契约验证。测试关闭扩展的自动模型整理，避免影响脚本化模型请求。

现有 Source → Chief → 用户决定 → Work 验证继续覆盖 Personal 装配。以上不能证明真实模型会正确选择值得保存的事实，或后台提炼、压缩后召回的实际质量；这些效果需要真实使用评估。真实 Channel 验收见 [E2E](../e2e.md)。

## 输入路由

ReconcileInput 不调用 Harness，也不注册单独的路由 Target 或 Lane。没有任何 Conversation 时创建并追加后结束；已有会话时，先追加到存在的默认联络处，再按确定性规则创建和关联具体会话。每个确定的会话立即接收 Input，追加幂等，无需等待完整路由计划。

目标 Conversation 的 Chief 沿用原有 Harness 会话和记忆机制，独立判断静默、通知、询问或推进工作。默认联络处接收所有 Input，但默认标记不构成执行授权，也不合并其它会话的上下文。
