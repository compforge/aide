# Output：持久输出与独立投递

Aide 会把多条观察合成一条通知，也会围绕同一个请求先报告进展，再交付结果。Input 表达收到的事实，Output 表达已经决定向外表达的内容，两者没有一对一约束。主动提醒可以没有 Input，`inputIds` 仅在需要追溯时保存相关输入，不承担消费回执或回复义务。

## 模型与流程

```text
Input → Route → Topic / Chief → Task / Routine
                         ↓ say              ↓ say
                               Output 持久资源
                                      ↓
                               Channel / Connector 投递与回执
```

Output 是 Personal 定义的 `aide.dev/v1alpha1 Output`。`spec.text`、`spec.receivers` 与 `spec.target` 在创建后不可变；Topic 的精确资源引用（包括 UID）记录归属，可选的 `executionId`、`producer`、`inputIds` 记录产出与材料。目标单独保存为 `Address`：`ChannelAddress extends Address` 使用 `kind: "channel"`、`channelId` 与 Channel 定义的 `endpoint`。Web endpoint 是会话标识，Lark endpoint 是分别 URI 编码的 appId / chatId。Personal 在产出时明确选择地址，Channel 发送时只读 target，不解析 Topic ID 或 sessionId。`RequirementAddress` 使用 Connector 名称、类别、工作项 ID 与规范项目 scope，供 Host 投递为工作项评论。更改正文、收件人或目标需要产生新的 Output。

`say` 成功返回 `{ outputId, accepted: true }`，只确认内容已持久化接纳，不表示已送达。Agent 记录已创建输出即可，不负责查询送达或投递重试；Host / Channel 维护持久投递状态，界面与诊断按需查看。不因 pending 重建消息。Chief 用工具调用 ID 去重；同一调用的重试返回原 Output，不同调用可以为同一批输入创建多个 Output。Task / Routine 的 report 原子提交业务进展与 Input 办理回执，say 独立创建 Output；两个工具不是同一笔事务。投递失败不会重新运行 Harness 或外部动作，输出存在也不证明 report 已成功。

## 地址与收件处

Input 的 `source?: Address` 表达事情发生、可以联络的位置；`sender` 引用 Person，`sessionId` 表达话题共性，三者独立。Lark Source 可以记录观察消息所在群的地址，这本身不要求回复。

Topic 的 `spec.address?: Address` 只在创建时从首个 Channel Input 初始化。Source 创建的会话不自动拥有默认地址；后续追加、转发到 default 会话或改变 default 标记均不覆盖地址，也不为无地址会话补值。

`say` 的目标选择：

1. `respondToInputId` 直接回复该 Input.source，并将它加入可选 inputIds；没有显式指定 receivers 时，以该 Input.sender 作为收件人。
2. `target` 明确选择通知地址，不能同时指定 respondToInputId。
3. 两者都未提供时，关联 Input（未指定时为当前调用关联的材料）中的 immediate 输入必须具有同一个地址；没有 immediate 输入时使用 Topic.address。

`Output.receivers` 是可选的 Person 资源引用列表，与 Input.sender 使用相同引用结构。它记录内容说给谁，target 记录送到哪里：可以在同一个群回复多人，也可以把多处信息整理后向另一个地址的负责人汇报。显式 receivers 覆盖直接回复的默认值，空列表表示不指定个人；仅关联 inputIds 不推导收件人。收件人不改变投递数量，不自动解析平台账号或添加群内 @。

Channel 地址在 Output 持久化之前还要通过实际投递配置校验：未启用 Lark 或 appId 与机器人 Channel 不一致时拒绝创建，ResourceClient 的组合事务整笔回滚。Connector 观察身份不等于机器人发送身份，不能直接替换 appId 来猜一个可达地址。

地址缺失或多个 immediate 地址冲突时，工具返回错误，要求明确选择；不会猜测会话名称或默认群。可以为多个 Input 合并生成一个 Output，也可以不关联 Input 而主动通知。Chief 提示词提供当前 Input 地址与 Topic 默认地址。

Work 的 say 通过所属 Topic 选择地址。缺少可用地址时返回错误，不创建无目标 Output；业务 report 与沟通独立，是否已完成应分别核对。

Output 的 `status` 由 Host 与 Channel 维护。Lark 持久记录 pending / sending、尝试次数、重试时间与最终 delivered；failed / uncertain 为终止或待核对状态，不自动重投。Web 创建成功即表示已发布，记录 delivered，不表示用户已经阅读。执行成功、业务目标完成、通知创建与外部送达各有独立证据。

## 原子提交与恢复

`ResourceClient.commit` 可在同一个插件实例范围内组合业务状态更新与 Output 创建。Host 用一个同步 SQLite 事务完成版本校验、容量检查和写入，提交后才发布变更通知。Harness 原生历史和远端发送不在该事务内。事务能力不意味着分别调用的 report 与 say 自动原子化。

事务内写过的资源不能被后续写入的容量回收淘汰。内容非法、版本冲突或受保护资源超过容量都会整笔回滚。业务执行已经发生后的提交冲突只重试提交，不重新执行动作。Output 身份对应内容指纹，回收后在 Host 去重窗口内仍拒绝恢复同一 Output 的投递。

投递层在启动时重新核对未完成 Channel Output，Store 只保存状态：没有已配置投递器接管且从未尝试发送的 pending 标为 failed，并记录目标和原因；sending 或已有发送尝试的 pending 标为 uncertain，保留可能已发生副作用的事实。不会自动改写目标或重发。无法接管时记录 error，包含 Output ID、目标、尝试次数和原因；实际发送失败按现有重试策略记录 warn，并带安全提取的平台错误码、HTTP 状态或网络错误码及下次重试时间。SDK 异常中的请求配置、凭证、消息正文和自由文本不写入日志或 Output.status。

Lark 长消息继续使用逐段回执和稳定的 provider UUID；重启后 sending 可继续投递。网络超时可能发生在远端接受之后，稳定 UUID 与本地回执降低重复风险，但不能超出提供方的去重保证。已保存的 target 让待发 Output 在 Topic 删除后仍可完成投递。进展卡片只展示和确认发往该聊天的 Output。

需求平台评论发送使用独立的 Host 投递器。没有已确认的提供方幂等键时，发送中断或超时进入 uncertain；匹配目标、正文及持久投递记录的回读可以确认成功，自动重发停止。详情见 [需求平台](../connector/requirements.md)。

## 关联、上下文与容量

Topic 不保存输出正文或无限增长的输出 ID 列表。界面按 Topic UID 展示产出记录，同时展示明确发往当前 Web endpoint 的 Output；跨会话投递只展示目标会话创建后的消息。同名会话删除后重建不会看见旧实例的产出记录。`say` 创建 Output 不改变 Input.assess；Chief 通过 assess_input 独立确认输入消费。未送达 Output 受容量保护，送达后可按资源策略回收；连续 loop 不无限持有输出 ID。已发生的动作与沟通由原生历史、业务状态和消费摘要承接。

Output 进入 Host 统一资源容量管理，配置键为 `aide.dev/Output`。pending / sending / uncertain 保持受保护；delivered 且无人引用时可以按配置回收；failed 保留诊断窗口后可释放。Input、Topic 与 producer 是追溯关系，不永久互相保活。Output 内容回收后，可读的长期上下文由 Topic summary / memory 承接。

Personal 声明 OutputPrinter，由 Host 加载，`describe` 返回完整正文、目标和投递信息，`summarize` 返回有界文本预览。ResourceClient 可以获取和列出 Output；投递状态由应用装配的投递器通过相同资源契约维护。

问题也是普通 Output；用户答复是新的 Input，由 Chief 的后续调用理解。原生工具权限与 Hook 信任使用独立 Approval，不通过普通业务消息确认。

验证场景见 `tests/address.test.ts`、`tests/output.test.ts`、`tests/topic-delete.test.ts` 与 Lark / Web 的投递、进展测试。
