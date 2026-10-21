# Harness

Harness 向 Aide 提供 Agent 执行能力。宿主通过统一接口提交输入、观察执行、取消或恢复会话；具体模型、原生协议和工具执行由 Harness 实现提供。插件通过 verb 请求执行，业务目标与结果判断仍由插件拥有。

[Pi](pi.md) 与 [Chief](chief.md) 是两个独立的 Harness 身份，当前复用 Pi Adapter；Codex、Claude 和 DSH 则通过各自的原生协议接入。Harness 身份既可以区分提供方，也可以区分有明确职责和工具集合的 Agent。

## 身份与职责

| 概念 | 职责 |
| --- | --- |
| Harness | 一种执行实现与能力集合，由注册表提供 |
| Target | 一份具体执行配置；同一 Harness 可以有多个 Target |
| Adapter | 把原生会话、工具与消息协议转换为宿主契约 |
| Agent | 决定如何使用模型与工具；内置 Agent 可有自己的提示词和上下文策略 |
| Aide Session / Lane / Turn | 宿主持久执行作用域、串行支线与每段执行的事实归属 |
| HarnessSession | Harness 自己管理的原生上下文与历史 |

Target 的 id 与 harness 字段分开：前者定位具体配置，后者选择实现。进程内会话句柄只用于路由调用；持久恢复依赖 Adapter 发布的原生身份与版本化恢复状态，宿主不能从临时句柄猜测稳定身份。

原生 Session 文件由 Harness 使用自己的默认目录保存，Aide 不托管或直接改写这些文件。Aide 的 Ledger 保存统一执行事实，不能由某一家原生历史替代。宿主按 `Session × Lane × Target` 保存原生 identity 与 Adapter 的 `resumeState`；恢复时原样交回 Adapter，进程期 Handle 不作为恢复身份。Session 的执行模型见 [Kernel](../kernel.md#harness-与执行事实)。

## 执行契约

核心接口保持小而明确：open 建立或恢复会话并绑定事件出口，sendTurn 提交输入，cancel 请求中断，close 释放会话。媒体、同轮 steer、压缩和交互等能力通过可选声明扩展，调用方不能假设所有 Harness 都支持。

请求由宿主分配身份、排队并持久化，再交给 Adapter。sendTurn 的回执只表示是否接受投递责任；执行进展与结束通过事件流报告。未支持的输入应在接受前明确拒绝；接受后的失败必须在事件流收口，不能让宿主一直等待。

每个被接受的新 Turn 都必须报告终态。取消请求发出后仍可能收到在途输出，最终结果以执行事件为准。宿主用自己的 Turn 身份关联事件，提供方的原生标识留在 Adapter 映射与诊断中。

Adapter 保留提供方明确给出的消息阶段。agentText 表达整轮记录，finalText 只包含明确的最终答复；不能按文本位置猜测结束。Turn 结束只说明本轮执行收口，目标是否达成由业务调用方校验。

## 工具、上下文与恢复边界

Harness 执行工具，插件定义工具背后的领域规则。通用 Pi 不认识 Work；Chief 的 WorkService 由 Personal 绑定会话范围。工具调用归一为执行事件，Channel 负责展示，不能用界面状态驱动业务完成。

原生会话恢复解决同一执行上下文如何继续；长期记忆解决哪些事实应被保留、修订和召回。Aide 通过具体 Harness 组合开源产品的通用记忆能力。Chief 维护可编辑的 PERSON.md，并内置 pi-hermes-memory 提供通用记忆和检索；Personal 绑定身份与文件路径，不负责模型提取或整理。存储与生命周期见 [Chief](chief.md#上下文与记忆)。通用 Harness 契约不增加记忆接口。

宿主拥有调度、期限、Interaction 与 Ledger，Adapter 拥有原生协议和会话清理，插件拥有业务恢复决策。可能已经发生外部副作用的中断不能仅凭通信重试自动重放。

## 实现与验证

[Pi](pi.md) 说明通用 SDK 会话和原生工具；[Chief](chief.md) 说明 Personal 能力、提示词与上下文。两者共用执行适配代码，新增 Agent 职责不需要复制流式、取消或恢复逻辑。

新增 Harness 时从注册表和 HarnessAdapter 契约接入，验证接受/拒绝、事件终态、取消、恢复身份及声明的可选能力。协议测试与真实提供方连通应分别记录；完整应用链路见 [E2E](../e2e.md)。
