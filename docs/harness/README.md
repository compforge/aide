# Harness

Harness 向 Aide 提供 Agent 执行能力。宿主通过统一接口提交输入、观察执行、取消或恢复会话；具体模型、原生协议和工具执行由 Harness 实现提供。插件通过 verb 请求执行，业务目标与结果判断仍由插件拥有。Harness 由应用按需装配，默认 Harness 来自启动配置；纯资源插件不启动执行后端。

[Pi](pi.md) 提供通用 SDK 适配；Codex、Claude 和 DSH 通过各自原生协议接入。Personal 的 [Route](../personal/route.md)、[Chief](../personal/chief.md)、[Task](../personal/task.md) 和 [Routine](../personal/routine.md) 使用独立配置身份，复用 PiAdapter 并注入领域工具。

## Operator 调用边界

Operator 根据 Harness interface，通过 verb 操作原生 agent loop。调用需要的配置名和会话引用都是显式参数；Harness verb 不读取或修改 CRD，也不知道 status.agent、Topic、Task 或 Routine。

调用方可以为服务重启保存少量参数，例如：

~~~ts
interface AgentStatus {
  harness: string;
  sessionId?: string;
}
~~~

harness 选择启动时配置的实现、模型和能力；sessionId 是原生会话身份。Operator 将这两个参数保存在自己的资源中；Harness 负责通过原生 SDK 定位、初始化和恢复会话，不向 Operator 暴露 sessionFile、resume.data 或空会话标记。底座不约定 status 字段，也没有资源到会话的持久目录。

未传 sessionId 的 prompt 新建原生会话；传入 sessionId 则复用运行句柄，或在重启后恢复该原生会话。相同配置可服务多个独立会话。运行句柄、runtimeId 和 invocationId 只用于进程内协调、并发保护和观测，不能用于恢复。

Route / Chief / Task / Routine 先调用 create，保存返回的恢复引用，然后提交长运行 prompt。保存失败时不提交业务输入，并关闭刚创建的运行句柄。不能在 create 阶段提供原生引用的 Harness 明确拒绝这个操作；一次性调用仍可直接 prompt，并在结束后返回已知引用。原生恢复失败明确返回，不自动另建会话。

原生历史、压缩与 checkpoint 由 Harness 管理。Operator 只保存调用参数；输入是否完成、如何重试和如何确认已有副作用，仍由业务资源与工具回执决定。

## 执行契约

Reconcile 经 `harness` verb 调用一个 `Harness` interface，具体 Adapter 是 Harness 的实现，拥有原生 session、连接和进程。宿主只保留有界调用记录和运行句柄，恢复引用通过 verb 返回给调用方。

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

首次执行由宿主分配 invocation 身份并限制并发；待处理业务事实由资源保存。运行中的追加直接调用 Harness 的原生能力，沿用当前宿主 invocation。接收回执不代表业务完成；执行进展与结束通过事件流报告。未支持的输入应在接受前明确拒绝；接受后的失败必须在事件流收口。追加操作只能指向调用资源拥有的 invocation。

每次被接受的 HarnessInvocation 都必须报告终态。取消请求发出后仍可能收到在途输出，最终结果以执行事件为准。原生审批中的“取消执行”只中断该审批关联的执行，不能影响使用同一配置 的其它资源；拒绝单次权限则允许 Harness 继续处理。宿主用 invocationId 关联事件，提供方的原生标识留在 Adapter 映射与诊断中。

Adapter 保留提供方明确给出的消息阶段。agentText 表达整轮记录，finalText 只包含明确的最终答复；不能按文本位置猜测结束。调用结束只说明本次执行收口，目标是否达成由业务调用方校验。

## 工具、上下文与恢复边界

Harness 执行工具，插件定义工具背后的业务规则。应用按执行 scope 绑定工具；工具调用时重新核对资源 UID 与当前 execution，避免使用过期的调用能力。原生会话负责连续推理；长期记忆由具体 Agent 组合，通用接口不强制提供记忆模型。Personal 的实践见 [Chief](../personal/chief.md#上下文与记忆)。

宿主拥有执行准入、期限、Approval 与有界实时投影，Harness 拥有原生协议和资源清理，插件拥有业务调度与恢复决策。取消执行仍需关闭失效句柄；保存恢复引用失败时释放句柄。原生会话不可恢复则明确报错，不静默创建新会话或重放可能产生副作用的输入。

HarnessActivity 保留活跃调用与有限近期执行供 Channel 展示，进程重启后这些细节消失。诊断日志、业务资源和原生会话各有存储生命周期，日志不承担恢复。

## 实现与验证

新增实现从注册表和 Harness interface 接入，验证创建、恢复引用、接受与拒绝、事件终态、取消和声明的可选能力。Pi 的 SDK 与扩展生命周期见 [Pi](pi.md)，领域工具和判断策略见 [Personal](../personal/README.md)。

协议测试与真实提供方连通分别记录；完整应用验收见 [E2E](../e2e.md)。
