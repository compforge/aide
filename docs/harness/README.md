# Harness

Harness 向 Aide 提供 Agent 执行能力。宿主通过统一接口提交输入、观察执行、取消或恢复会话；具体模型、原生协议和工具执行由 Harness 实现提供。插件通过 verb 请求执行，业务目标与结果判断仍由插件拥有。Harness 由应用按需装配，默认 Target 来自配置；纯资源插件不启动执行后端。

[Pi](pi.md)、[Chief](chief.md) 与 [Route](route.md) 是独立的 Harness 身份，复用 Pi Adapter；Codex、Claude 和 DSH 则通过各自的原生协议接入。Harness 身份既可以区分提供方，也可以区分有明确职责和工具集合的 Agent。

Route 使用专用分类提示词，只有 route_input、目录读取和共享记忆检索工具。它提交 Input 与已有 Conversation 的关联，宿主保存计划并投递；角色、连续执行与恢复见 [Route](route.md)，业务协作见 [Personal](../plugin/personal.md#输入与上下文)。

## 身份与职责

| 概念 | 职责 |
| --- | --- |
| Harness | 一种执行实现与能力集合，由注册表提供 |
| Target | 一份具体执行配置；同一 Harness 可以有多个 Target |
| Adapter | 把原生会话、工具与消息协议转换为宿主契约 |
| Agent | 决定如何使用模型与工具；内置 Agent 可有自己的提示词和上下文策略 |
| Resource 执行上下文 | 由资源 UID 与 Controller 定位，供多次 Reconcile 持续使用 |
| HarnessSession | Harness 自己管理的原生上下文与历史 |

Target 的 id 与 harness 字段分开：前者定位具体配置，后者选择实现。进程内会话句柄只用于路由调用；持久恢复依赖 Adapter 发布的原生身份与版本化恢复状态，宿主不能从临时句柄猜测稳定身份。

原生 Session 文件由 Harness 自己保存，Aide 不托管或改写。需要持续 Agent 的资源通过 `status.agent` 保存实际执行绑定：

```ts
interface AgentStatus {
  harness: string;
  targetId: string;
  session?: {
    id: string;
    resume?: { version: number; data: unknown };
  };
}
```

`harness` 选择实现，`targetId` 标识实际配置；`session.id` 是原生身份，不能使用进程期 handle 代替。`resume` 只保存 ID 以外必要的定位信息，例如 Pi 的 sessionFile；数据由 Adapter 生成并解释，Aide 原样保存和回传。工作目录来自执行配置，Harness 自行校验恢复约束。

插件调用 `harness({ agentKey: "agent", ... })` 选择所属资源的 status 字段，资源 Schema 声明对应 AgentStatus。Host 通过 UID 和版本检查保存绑定，避免并发覆盖业务状态或挂到删除后重建的资源。已知的绑定在发送 prompt 前写入；延迟公布的绑定在调用返回前等待写入完成。写入失败不能报告调用成功。

Aide 重启后读取资源引用，让 Harness 恢复原生会话，再提交新输入。原生历史、压缩与 checkpoint 由 Harness 管理；恢复失败明确报告。Aide 没有 HarnessStore 或执行日志重放，不构造历史补偿提示词。一次性 Work 调用可使用 freshContext，直接提供有界业务材料而不保存持续会话引用。

## 执行契约

核心接口保持小而明确：open 建立或恢复会话并绑定事件出口，sendTurn 提交输入，cancel 请求中断，close 释放会话。媒体、同轮 steer、压缩和交互等能力通过可选声明扩展，调用方不能假设所有 Harness 都支持。

请求由宿主分配身份并排队，再交给 Adapter；待处理业务事实由资源保存。sendTurn 的回执只表示是否接受投递责任；执行进展与结束通过事件流报告。未支持的输入应在接受前明确拒绝；接受后的失败必须在事件流收口，不能让宿主一直等待。

每次被接受的 HarnessInvocation 都必须报告终态。取消请求发出后仍可能收到在途输出，最终结果以执行事件为准。原生审批中的“取消执行”只中断该审批关联的执行，不能影响共享 Target 的其它资源；拒绝单次权限则允许 Harness 继续处理。宿主用 invocationId 关联事件，提供方的原生标识留在 Adapter 映射与诊断中。

Adapter 保留提供方明确给出的消息阶段。agentText 表达整轮记录，finalText 只包含明确的最终答复；不能按文本位置猜测结束。调用结束只说明本次执行收口，目标是否达成由业务调用方校验。

## 工具、上下文与恢复边界

Harness 执行工具，插件定义工具背后的领域规则。通用 Pi 不认识 Work；Chief 的 WorkService 由 Personal 绑定会话范围。工具调用归一为执行事件，Channel 负责展示，不能用界面状态驱动业务完成。

原生会话恢复解决同一执行上下文如何继续；长期记忆解决哪些事实应被保留、修订和召回。Aide 通过具体 Harness 组合开源产品的通用记忆能力。Chief 通过 profile_person 维护共享 Person CRD，并内置 pi-hermes-memory 提供其它通用记忆和检索；Personal 管理身份与资源一致性，Chief 负责理解与修订。存储与生命周期见 [Chief](chief.md#上下文与记忆)。通用 Harness 契约不增加记忆接口。

宿主拥有调度、期限、进程内原生权限 Approval 与有界实时投影，Adapter 拥有原生协议和会话清理，插件拥有业务恢复决策。可能已经发生外部副作用的中断不能仅凭通信重试自动重放。

## 实现与验证

[Pi](pi.md) 说明通用 SDK 会话和原生工具；[Chief](chief.md) 说明 Personal 能力、提示词与上下文。[Route](route.md) 说明输入分派、工具和恢复。三者共用执行适配代码，新增 Agent 职责不需要复制流式、取消或恢复逻辑。

新增 Harness 时从注册表和 HarnessAdapter 契约接入，验证接受/拒绝、事件终态、取消、恢复身份及声明的可选能力。协议测试与真实提供方连通应分别记录；完整应用链路见 [E2E](../e2e.md)。
