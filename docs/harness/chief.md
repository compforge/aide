# Chief Harness

Chief 是 Aide 负责接话与判断的入口 Agent。用户消息或外部观察到来后，它结合上下文决定直接回答、询问用户、操作 Work，或忽略不值得打扰的观察。Chief 的判断质量，尤其是提示词、上下文组织与记忆机制，是 Personal Agent 的持续优化重点。

Chief 使用独立的 `chief` Harness 身份，Agent 位于 `agents/chief/`；它组合 [通用 Pi](pi.md)，复用 PiAdapter 的执行与事件机制。通用边界见 [Harness](README.md)，工作生命周期与问答编排见 [Personal](../plugin/personal.md)。

## Agent 与 Controller

Chief Agent 拥有 Personal 提示词和工具，负责具体判断。Chief Controller 按 Conversation 消费 Input、准备本轮上下文、调用 Harness 并续接用户答复。Task / Routine 的持久状态与 Reconcile 属于 Personal，Agent 通过工具访问，不能直接宣告资源完成。

Personal 在所属 Session 内为每个 Conversation 绑定固定 Lane、Chief Target 和 WorkService，并提供问答与 Connector 工具。宿主装配使用 `chiefSession` 工厂；缺少绑定时创建 Chief Harness 会报错，不会降级为通用 Pi。

```ts
const adapter = createHarnessAdapter(
  { id: chiefTargetId, harness: "chief" },
  { ...ports, targetConfig: { harness: "chief" },
    chiefSession: aide.chiefSession(chiefTargetId) },
);
```

Chief 的模型选择与能力包配置位于 `harnesses.chief`，完整来源、优先级和同步流程见 [配置](../configuration.md)。
启动装配解析模型定义、认证来源和能力包，并将有效配置注入 `chiefSession`；Personal 只绑定业务工具。显式 model 覆盖 Pi 定义，缺省规则见配置文档。`AIDE_MODEL` 控制默认 Codex Target，不改变 Chief 模型。
Chief 加载已同步的声明包中的 skills，以及内置 Hermes 扩展提供的记忆工具与自维护 skills；不继承用户或项目的自动扩展、skill 包发现。角色规则与 Work 工具仍由代码绑定。
原生会话由 Pi SDK 存放在自己的默认目录，与通用 Pi 一样；Chief 角色通过 scope 区分，不靠另建 chief-sessions 目录区分。连续输入复用该 Lane × Target 的原生会话，服务重启后 Core 把保存的 resumeState 交回 Adapter；新的 Input 创建新 Turn。原生恢复范围绑定 conversationId，不能把另一会话或通用 Pi 的会话文件当成当前上下文。

## 提示词与工具

当前稳定角色规则在 `agents/chief/agent.ts`，包括自然接话、按需创建工作、先检查关联工作、依据工具结果报告操作，以及对外部内容的处理原则。`plugins/personal/chief.ts` 组装运行提示，补充 Source 判断约定、当前时间、输入与近期消息；收到用户答复后构造续轮提示。

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
