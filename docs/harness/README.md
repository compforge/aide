# Harness

Harness 向 Aide 提供 Agent 执行能力。宿主通过统一接口提交输入、观察执行、取消或恢复会话；具体模型、原生协议和工具执行由 Harness 实现提供。插件通过 verb 请求执行，业务目标与结果判断仍由插件拥有。Harness 由应用按需装配，默认 Harness 来自启动配置；纯资源插件不启动执行后端。

[Pi](pi.md)、[Chief](chief.md)、[Task](task.md) 与 [Route](route.md) 是独立的 Harness 身份，复用 Pi Adapter；Codex、Claude 和 DSH 则通过各自的原生协议接入。Harness 身份既可以区分提供方，也可以区分有明确职责和工具集合的 Agent。

Route 使用专用分类提示词，只有 route_input、目录读取和共享记忆检索工具。它提交 Input 与已有 Conversation 的关联，宿主保存计划并投递；角色、连续执行与恢复见 [Route](route.md)，业务协作见 [Personal](../plugin/personal.md#输入与上下文)。

## Operator 调用边界

Operator 根据 Harness interface，通过 verb 操作原生 agent loop。调用需要的配置名和会话引用都是显式参数；Harness verb 不读取或修改 CRD，也不知道 status.agent、Conversation、Task 或 Routine。

Personal 为服务重启保存少量参数：

~~~ts
interface AgentStatus {
  harness: string;
  sessionId?: string;
}
~~~

harness 选择启动时配置的实现、模型和能力；sessionId 是原生会话身份。Operator 将这两个参数保存在自己的资源中；Harness 负责通过原生 SDK 定位、初始化和恢复会话，不向 Operator 暴露 sessionFile、resume.data 或空会话标记。底座不约定 status 字段，也没有资源到会话的持久目录。

未传 sessionId 的 prompt 新建原生会话；传入 sessionId 则复用运行句柄，或在重启后恢复该原生会话。相同配置可服务多个独立会话。运行句柄、runtimeId 和 invocationId 只用于进程内协调、并发保护和观测，不能用于恢复。

Route / Chief / Task 先调用 create，保存返回的恢复引用，然后提交长运行 prompt。保存失败时不提交业务输入，并关闭刚创建的运行句柄。不能在 create 阶段提供原生引用的 Harness 明确拒绝这个操作；一次性调用仍可直接 prompt，并在结束后返回已知引用。原生恢复失败明确返回，不自动另建会话。

原生历史、压缩与 checkpoint 由 Harness 管理。Operator 只保存调用参数；输入是否完成、如何重试和如何确认已有副作用，仍由业务资源与工具回执决定。

## 执行契约

Reconcile 经 `harness` verb 调用一个 `Harness` interface，不经过 Binding 或另一个 Agent interface。具体 Adapter 是 Harness 的实现，拥有原生 session、连接和进程。宿主只保留有界调用记录和运行句柄，恢复引用通过 verb 返回给调用方。

下表描述 Verb 层的操作与返回语义。Harness 的输入方法先返回接收回执，再通过事件报告执行；prompt 的 Verb 封装等待最终结果，followUp / steer 则只等待接收结果。

| 操作 | 契约 |
| --- | --- |
| create | 建立新会话，订阅事件与恢复引用更新；不自动提交输入 |
| resume | 按明确的原生 sessionId 恢复；不自动执行或重放 |
| prompt | 空闲时提交新输入；返回完成的 invocation 与结果 |
| followUp | 运行中追加普通输入，交给原生队列，在当前工作结束后处理 |
| steer | 在原生安全边界向正在运行的 invocation 追加紧急输入 |
| abort | 请求取消当前执行，最终结果由事件确认 |
| close | 释放运行资源，保留原生持久会话 |

创建与恢复时传入事件出口，相当于订阅原生执行。`followUp`、`steer` 由可选方法声明能力；不支持时明确拒绝，不在 Host 模拟提供方队列。Pi 实现原生 followUp 和 steer；resume 后通过 prompt 发起执行。

首次执行由宿主分配 invocation 身份并限制并发；待处理业务事实由资源保存。运行中的追加直接调用 Harness 的原生能力，不再等待一个新的宿主 invocation。接收回执不代表业务完成；执行进展与结束通过事件流报告。未支持的输入应在接受前明确拒绝；接受后的失败必须在事件流收口。追加操作只能指向调用资源拥有的 invocation。

每次被接受的 HarnessInvocation 都必须报告终态。取消请求发出后仍可能收到在途输出，最终结果以执行事件为准。原生审批中的“取消执行”只中断该审批关联的执行，不能影响使用同一配置 的其它资源；拒绝单次权限则允许 Harness 继续处理。宿主用 invocationId 关联事件，提供方的原生标识留在 Adapter 映射与诊断中。

Adapter 保留提供方明确给出的消息阶段。agentText 表达整轮记录，finalText 只包含明确的最终答复；不能按文本位置猜测结束。调用结束只说明本次执行收口，目标是否达成由业务调用方校验。

## 工具、上下文与恢复边界

Harness 执行工具，插件定义工具背后的领域规则。通用 Pi 不认识 Work；Chief 的 WorkService 由 Personal 根据调用 scope 中的 ResourceRef 装配；工具每次调用重新核对资源 UID 和当前 execution，不能捕获已结束执行的 verbs。工具调用归一为执行事件，Channel 负责展示，不能用界面状态驱动业务完成。

原生会话恢复解决同一执行上下文如何继续；长期记忆解决哪些事实应被保留、修订和召回。Aide 通过具体 Harness 组合开源产品的通用记忆能力。Chief 通过 summary_person 维护共享 Person CRD，并内置 pi-hermes-memory 提供其它通用记忆和检索；Personal 管理身份与资源一致性，Chief 负责理解与修订。存储与生命周期见 [Chief](chief.md#上下文与记忆)。通用 Harness 契约不增加记忆接口。

宿主拥有执行准入、期限、原生权限 Approval 与有界实时投影，Harness 拥有原生协议和运行资源清理，插件拥有业务调度与恢复决策。已取消的 invocation 与失效的运行句柄分别处理：取消不能跳过关闭；引用保存失败后释放句柄，下一次根据会话引用重新打开。原生会话无法恢复时保留引用并报告错误。可能已经发生外部副作用的中断不能仅凭通信重试自动重放。

## 实现与验证

[Pi](pi.md) 说明通用 SDK 会话和原生工具；[Chief](chief.md) 说明 Personal 能力、提示词与上下文。[Route](route.md) 说明输入分派、工具和恢复。[Task](task.md) 说明持续办理、工具回执和静默回收。四者共用执行适配代码，新增 Agent 职责不需要复制流式、取消或恢复逻辑。

新增 Harness 时从注册表和 HarnessAdapter 契约接入，验证接受/拒绝、事件终态、取消、恢复身份及声明的可选能力。协议测试与真实提供方连通应分别记录；完整应用链路见 [E2E](../e2e.md)。
