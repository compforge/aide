# Chief Harness

Chief 是 Aide 负责接话与判断的入口 Agent。用户消息或外部观察到来后，它结合上下文决定直接回答、询问用户、操作 Work，或忽略不值得打扰的观察。Chief 的判断质量，尤其是提示词、上下文组织与记忆机制，是 Personal Agent 的持续优化重点。

Chief 使用独立的 `chief` Harness 身份，Agent 位于 `agents/chief/`；它组合 [通用 Pi](pi.md)，复用 PiAdapter 的执行与事件机制。通用边界见 [Harness](README.md)，工作生命周期与问答编排见 [Personal](../plugin/personal.md)。

## Agent 与 Controller

Chief Agent 拥有 Personal 提示词和工具，负责具体判断。Chief Controller 按 Conversation 消费 Input、准备本轮上下文、调用 Harness 并续接用户答复。Task / Routine 的持久状态与 Reconcile 属于 Personal，Agent 通过工具访问，不能直接宣告资源完成。

Personal 为每个 Conversation 绑定 Chief Target 和 WorkService，并提供问答与 Connector 工具。宿主装配使用 `chiefSession` 工厂；缺少绑定时创建 Chief Harness 会报错，不会降级为通用 Pi。

```ts
const adapter = createHarnessAdapter(
  { id: chiefTargetId, harness: "chief" },
  { ...ports, targetConfig: { harness: "chief" },
    chiefSession: aide.chiefSession(chiefTargetId) },
);
```

Chief 的模型选择与能力包配置位于 `harnesses.chief`，完整来源、优先级和同步流程见 [配置](../configuration.md)。
显式 model 优先于工厂默认值和 Pi 默认模型；未配置时沿用 Pi。`AIDE_MODEL` 控制默认 Codex Target，不改变 Chief 模型。
Chief 只加载已同步的声明包中的 skills，不继承用户或项目的自动 skill 发现；角色规则与 Work 工具仍由代码绑定。
原生会话由 Pi SDK 存放在自己的默认目录，与通用 Pi 一样；Chief 角色通过 scope 区分，不靠另建 chief-sessions 目录区分。原生恢复范围绑定 conversationId，不能把另一会话或通用 Pi 的会话文件当成当前上下文。

## 提示词与工具

当前稳定角色规则在 `agents/chief/agent.ts`，包括自然接话、按需创建工作、先检查关联工作、依据工具结果报告操作，以及对外部内容的处理原则。`plugins/personal/chief.ts` 组装运行提示，补充 Source 判断约定、当前时间、输入与近期消息；收到用户答复后构造续轮提示。

Chief 在 Pi 的文件与 CLI 能力上增加以下业务工具：

- Work 工具读取、创建、更新与删除绑定会话的 Task / Routine，具体契约见 [Personal](../plugin/personal.md)。
- ask / confirm 提出问题意图，Controller 在模型 Turn 结束后通过 Core Interaction 等待答复。
- Connector 工具使用 Host 的全局目录，查询需求、PR、评论和环境声明。`list_environments` 列举环境，`read_environment` 按名称或别名返回规范身份与访问坐标；这些声明不代表连通性或健康状态。
- dismiss_observation 保存忽略原因，让不值得通知的 Source 观察静默结束。

提示词表达判断策略，工具边界保证持久化与会话范围。Work 写工具在提出问题后暂停接受修改，直到用户答复进入续轮；这项约束不能只依赖模型记住提示。

## 当前上下文与记忆边界

当前每个输入建立独立 Lane；同一输入内的问答续轮保留原生 Pi 会话。Controller 读取当前 Conversation 的近期消息和工作回复作为上下文，Chief 还可以通过 Work / Connector 工具按需补充事实。

现有持久数据承担不同职责：

| 数据 | 当前用途 |
| --- | --- |
| Conversation / Message | 交流历史和近期上下文 |
| Task / Routine | 已承担工作的目标、状态与执行记录 |
| Session Ledger | 执行过程、展示与诊断 |
| Pi 原生会话 | 当前输入及问答续轮的模型上下文与恢复 |

这些记录提供历史来源，但当前没有专门的长期记忆提取、修订与召回机制，也没有自动跨 Conversation 召回。会话文件存在不等于 Chief 已能持续记住用户偏好或在新输入中检索所有历史。

## 优化重点

以下是后续设计方向，本次未新增记忆存储或检索实现：

- **提示词组织**：明确稳定角色规则、动态事实和输入内容各自的位置，收敛 Agent 与 Controller 中重复的判断规则。用真实场景检查普通问答是否过度创建工作、工作关联是否准确、何时应询问用户。
- **上下文选择**：围绕当前输入选择相关工作与事实，保留来源和时效，减少无关历史；上下文不足时补查，而不是靠模型猜测。
- **长期记忆**：确定哪些稳定偏好、工作背景与长期关注值得保存，何时写入、修订、遗忘和召回。Task / Routine 仍是工作状态的权威来源，避免记忆另存一套过期进展。
- **跨会话使用**：把可共享的长期背景与各会话的即时交流区分开。是否共享、共享什么需要明确设计，不把不同群或不同 Source 的完整聊天直接拼在一起。
- **效果验证**：通过可回放场景检验正确关联工作、必要追问、纠正过期记忆，以及是否减少遗漏和无效打扰。持续记录效果与成本，再决定需要增加哪种机制。

具体记忆形态与存储尚未选定。先优化一个真实工作场景的判断与跟进效果，保持通用 Harness 接口稳定，将个人助手策略留在 Chief / Personal。

## 验证

现有测试覆盖 Chief Work CRUD、会话恢复边界，以及 Source → Chief → 用户决定 → Work 的装配。模型与外部服务使用替身，可以证明工具和执行契约，不能证明提示词效果或尚未实现的长期记忆能力。真实 Channel 验收见 [E2E](../e2e.md)。
