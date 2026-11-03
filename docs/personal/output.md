# Output：持久输出与独立投递

披露权限与实际投递见 [披露边界](disclosure.md)：材料使用 sensitivity/visibility，人物使用 clearance；Output 由 Reconciler 检查后投递。

## 整体定位

Aide 基于已有的近期、长期 Note 与最新 Input 判断是否需要沟通；更新 Note 可以静默完成，私下答复 Me 不以先持久化 Note 为前提，对外正文须引用可分类的 Note。Aide 会把多条观察合成一条通知，也会围绕同一个请求先报告进展，再交付结果。Input 表达收到的事实，Output 表达已经决定执行的投递，两者没有一对一约束。主动提醒可以没有 Input，`inputIds` 仅在需要追溯时保存相关输入，不承担消费回执或回复义务。

## 流式生成与投递

需要直接回复的 Immediate Channel Input 在 Chief 调用模型前建立 Output 与原始 Stream。
两者在同一存储事务建立，提交后消费者才能看到，`spec.stream` 是固定 UID 的 ResourceRef。
Agent 是寄件人，Stream 是邮件，Output 与 Reconcile 负责投递。Chief 的消息、思考与工具事件按 150ms 批次追加；完整 upsert、修正和清空保留协议语义，不把事件压平成两条字符串。
其它后台执行保持静默，需要沟通时通过 say 创建已完成的 Stream。

Output.spec 的 receivers/target/stream 表达原定意图，status.delivery 对应实际接收人、
投递坐标和 Stream，并通过 confirmedSeq 与 receipt 保存实际投递进度。Reconcile 无需
更改内容时复用原始 Stream；需要话术时由系统邮件 writer 创建同协议的 Stream 并关闭，不改原始流。

Note 引用放在 Stream.status.references，记录 UID、读取版本与正文指纹。实时生成期间通过
`cite_output` 补充引用，关闭后冻结；say 的 notes 参数在写信时转成相同引用。Note 保持原 subject
和生命周期。Agent 负责整份 Stream 的内容、分类和引用完整性。Reconcile 读取引用及 Note 当前权限、敏感度，
核对引用有效性后决定下一跳；内容不经模型复审或长度门槛。Output.spec 不再承载 notes、think、text 或工具事件。

Immediate Input 遇到 mute：实际地址保持原计划地址，实际流替换成固定禁言提示。
其它 Input 遇到 mute：实际地址改为 Me 默认地址，正文复用原始流。默认地址仍需通过
私密 Me 身份、可用性和禁言检查。禁言例外只允许固定提示，不能夹带生成内容。

Reconcile 建立投递后，Host 持有可关闭、可恢复的 Stream 消费任务，Runner 只进行生命周期
协调与失败重试。Stream 追加不通过 Watch 唤醒 Output。投递按 750ms 节奏合并更新，
不支持消息更新的 Connector 等待流结束后发送完整正文。

已验证的私密 Me 地址可持续展示新内容；外部地址等待 Stream 关闭、引用集合冻结后按元数据授权。
生成中的引用集合尚未完整，不能提前授权外部投递。权限变化后停止继续投递，已发生的外部效果不会被改写。
Lark 卡片由实际 Output Stream 驱动，停止原有按 Topic 投影、旁路发送的执行卡片。

Stream.completed 只表示生成完成；Output.delivered 还要求实际流的末尾内容已确认送达。
中断流保留已有内容并显示失败，重启不会把残缺内容伪装成成功。Output 删除级联清理原始与
替换 Stream 及追加数据。底座契约见 [Stream](../plugin/stream.md)。不提供旧 text 数据兼容。

## CRD

### Spec

```text
Input → Route → Topic / Chief → Task / Routine
                         ↓ say              ↓ say
                               Output 持久资源
                                      ↓
                               Channel / Connector 投递与回执
```

Output 是 Personal 定义的 `aide.dev/v1alpha5 Output`。`spec.stream`、`spec.receivers` 与 `spec.target` 在创建后不可变；Topic 的精确资源引用（包括 UID）记录归属，可选的 `executionId`、`producer`、`inputIds` 记录产出与材料。目标保存为独立 Address 资源的 UID 引用；平台位置保存在 Address.spec.locators，实际发送坐标保存在 status.delivery.target。传输地址中，`ChannelAddress extends Address` 使用 `kind: "channel"`、`channelId` 与 Channel 定义的 `endpoint`。Web endpoint 是会话标识，Lark 聊天 endpoint 是分别 URI 编码的 appId / chatId；按用户身份投递时为 appId / open_id / openId。Personal 在产出时明确选择地址，Channel 发送时只读检查后 status.delivery 的 target/stream，不解析 Topic ID 或 sessionId。`RequirementAddress` 使用 Connector 名称、类别、工作项 ID 与规范项目 scope，供 Host 投递为工作项评论。更改正文、收件人或目标需要产生新的 Output。

### Status

phase 表达 pending、sending、delivered、failed、uncertain 或 cancelled；attempts 保存尝试次数，底座队列负责错误退避，deliveredAt、receipt 保存投递依据，lastError 保存安全提取的错误。字段见 [OutputStatus](../../plugins/personal/output/model.ts)。spec 的 receivers/stream/target 表示预期发给谁、发什么、在哪里发；status.delivery 的对应字段记录实际投递给谁、发什么、在哪里发。状态由 Output Reconciler 维护，创建成功与外部送达分开。

## 投递与恢复

Output 由独立 Reconciler 检查材料与受众，并持久化实际投递目标及 Stream 引用；正文一致性校验使用隔离的模型调用。同一 Reconciler 调用 Host 装配的 Channel / Connector transport 完成投递和重试。

### 原子提交与恢复

中断 Work 原子记录 uncertain 和 recoveryNotice，再通过统一 say 显式联系 Me。解析失败保留通知待办，30 秒后重试，重启继续处理；通知 ID 作为幂等键，创建 Output 后清除待办。通知没有原 Topic 地址也能发出，通知失败不重放业务执行。

`ResourceClient.commit` 可在同一个插件实例范围内组合业务状态更新与 Output 创建。Host 用一个同步 SQLite 事务完成版本校验、容量检查和写入，提交后才发布变更通知。Harness 原生历史和远端发送不在该事务内。事务能力不意味着分别调用的 report 与 say 自动原子化。

事务内写过的资源不能被后续写入的容量回收淘汰。内容非法、版本冲突或受保护资源超过容量都会整笔回滚。业务执行已经发生后的提交冲突只重试提交，不重新执行动作。Output 身份对应内容指纹，回收后在 Host 去重窗口内仍拒绝恢复同一 Output 的投递。

启动时，底座唤醒未完成 Output，由各自 Reconciler 重新检查依赖和投递能力。准备失败按资源退避，明确的永久拒绝转为 failed；其它 Output 独立推进。投递适配器通过 [DeliveryError](../connector/extensions.md#host-投递错误) 区分结果：明确未产生副作用的可重试拒绝保持 pending（包括非幂等写入的 429）；永久拒绝进入 failed；未知结果只有幂等发送能保持消息身份继续，其余进入 uncertain。非幂等 sending 中断仍标记 uncertain。

适配器提供 retryAfterMs 时，拒绝原因和 `deliveryWait: {reason: "provider", until}` 一起持久化，再通过已有 requeueAfterMs 定时协调。提前 Watch 或重启唤醒不会绕过该 deadline；到期重新检查披露和人物频率。没有提示时使用控制器错误退避。等待不占据发送执行权，不增加 attempts，不创建新 Output 或重做 Chief；只有再次调用发送才增加 attempts。重试成功清除等待和错误，永久失败保留原因。

失败日志记录 Output ID 和安全提取的诊断，Lark 另记录目的地、分片、平台错误码、HTTP 状态或网络错误码。SDK 请求配置、凭证、消息正文和自由文本不写入日志或 Output.status。

Address.muted 对原文、分片及进度卡均生效；Immediate Input 对应的 Output 由 Reconcile 在原地址投递固定禁言提示，其它禁言 Output 转投 Me 的默认地址，详见 [披露边界](disclosure.md)。Chief 提交 raw Output，实际 target/stream 调整只保存在 status.delivery。群成员使用持续观察积累的 Address.people。Lark 长消息继续使用逐段回执和稳定的 provider UUID；重启后 sending 可继续投递。网络超时可能发生在远端接受之后，稳定 UUID 与本地回执降低重复风险，但不能超出提供方的去重保证。已保存的 target 让待发 Output 在 Topic 删除后仍可完成投递。进展卡片消费实际 Stream；私密 Me 地址可显示 Stream 内的思考、工具与正文；外部地址等待完整披露检查，工具过程同样来自经过选择的邮件。

需求平台评论发送使用独立的 Host 投递器。没有已确认的提供方幂等键时，发送中断或超时进入 uncertain；匹配目标、正文及持久投递记录的回读可以确认成功，自动重发停止。详情见 [需求平台](../connector/requirements.md)。

### 关联、上下文与容量

Topic 不保存输出正文或无限增长的输出 ID 列表。界面按 Topic UID 展示产出记录，同时展示明确发往当前 Web endpoint 的 Output；跨会话投递只展示目标会话创建后的消息。同名会话删除后重建不会看见旧实例的产出记录。`say` 创建 Output 不改变 Input.assess；Chief 通过 assess_input 独立确认输入消费。未送达 Output 受容量保护，送达后可按资源策略回收；连续 loop 不无限持有输出 ID。已发生的动作与沟通由原生历史、业务状态和消费摘要承接。

Output 进入 Host 统一资源容量管理，配置键为 `aide.dev/Output`。pending / sending / uncertain 保持受保护；delivered 且无人引用时可以按配置回收；failed 保留诊断窗口后可释放。Input、Topic 与 producer 是追溯关系，不永久互相保活。Output 内容回收后，可读的长期上下文由 Topic summary / memory 承接。

Personal 声明 OutputPrinter，由 Host 加载，`describe` 返回 Stream 引用、目标和投递信息，`summarize` 返回流标识与状态。Web 查询通过内容投影解析邮件预览与详情，复用游标缓存，避免每次读取全部事件。ResourceClient 可以获取和列出 Output；投递状态由应用装配的投递器通过相同资源契约维护。

问题也是普通 Output；用户答复是新的 Input，由 Chief 的后续调用理解。原生工具权限与 Hook 信任使用独立 Approval，不通过普通业务消息确认。

验证场景见 `tests/address.test.ts`、`tests/output.test.ts`、`tests/topic-delete.test.ts` 与 Lark / Web 的投递、进展测试。

## Web 查询

`/outputs` 提供跨 Topic 的列表与详情，按创建时间倒序分页，可按正文或 ID、Topic、接收人、Address、披露结果、投递状态与创建时间范围筛选。接收人与地址匹配原定意图或实际投递，列表与详情分别标注。导航按 Inputs、Topics、Persons、Addresses、Outputs 排列，体现从输入到输出的流程。

详情分别展示生成正文、原定发送、披露检查和实际投递；拒绝原内容外发与转告 Me 的通知送达可以同时成立。等待原因与预计重试仅在 pending / sending 展示，当前状态不被拼成完整重试历史；送达不表示已读。创建 Output 之前的失败需从执行记录追查。

生成 Session 仅按 Output.createdBy 中的原生身份读取，不接受用户指定路径或任意 Session。关联对象按精确 UID 解析；删除或同名重建后保留原引用并标明不可用。结构化条件先按数据库过滤分页；正文搜索对候选邮件做内容投影再分页，复用缓存。查询不刷新回收访问时间。列表与详情自动刷新，隐藏页面暂停轮询请求；回收后的记录不再可查。

## 产出 Agent 的职责

### 统一沟通工具

`say` 成功返回 `{ outputId, accepted: true }`，只确认内容已持久化接纳，不表示已送达。Agent 记录已创建输出即可，不负责查询送达或投递重试；Output Reconciler 维护持久投递状态，界面与诊断按需查看。不因 pending 重建消息。Chief 用工具调用 ID 去重；同一调用的重试返回原 Output，主动沟通的不同调用可以为同一批材料创建多个 Output；明确 respondToInputId 的答复按原始消息去重，见 [Address](address.md)。Task / Routine 的 report 原子提交业务进展与 Input 办理回执，say 独立创建 Output；两个工具不是同一笔事务。投递失败不会重新运行 Harness 或外部动作，输出存在也不证明 report 已成功。

Chief、Task、Routine 共用 say 和 list_addresses / read_address。Aide 始终是发送者；to={me:true} 联系被服务者，target=AddressRef 选择已知场合。Agent 根据已有委托判断主动联系权限；工具验证活跃执行、输入归属、身份与目的地，Channel 使用自己的机器人身份发送。知道某人的身份、能读取其消息，不构成主动联系授权。

list_addresses 可按 Person UID 查找相关场合，read_address 提供其认识、禁言和已知参与者。Agent 不传平台 endpoint 或 Channel 配置名。to 与 target / receivers 互斥；respondToInputId 与 to 互斥，可与 target 一起指定答复及场合。

Lark Input 引用聊天 Address，replyToMessageId 单独记录原消息 ID。回复时使用 SDK message.reply 和 reply_in_thread，Output 持久保存该位置；不会仅因同属一个 Topic 就在群主流发出话题答复。

### 地址与收件处

Input 的 `source?: AddressRef` 表达事情发生、可以联络的位置；`sender` 引用 Person，`sessionId` 表达话题共性，三者独立。Lark Source 可以记录观察消息所在群的地址，这本身不要求回复。

Topic 的 `spec.address?: AddressRef` 只在创建时从首个 Channel Input 初始化。Source 创建的会话不自动拥有默认地址；后续追加或路由到系统 Default 均不覆盖地址，也不为无地址会话补值。

`say` 的目标选择：

1. `respondToInputId` 接受 Channel Input 和 Source 的原始群内 @Me 消息，默认回复 source，并将它加入 inputIds；没有显式 receivers 时以 Input.sender 为收件人。普通 Source 观察不自动成为代答入口。
2. `target` 明确选择场合；可与 respondToInputId 同时提供，例如将群内问题的敏感答复改到合适的私有地址。
3. 两者都未提供时，关联 Input（未指定时为当前调用关联的材料）中的 immediate Channel 输入具有同一个有效地址，则按规则回复该地址，包括原群。不能唯一确定时，由当前 Agent 判断相关 Address 并通过 target 指定；Agent 也无法确定、仍省略地址时，通过默认 Address 联系 Me。Topic.address 不作为通知的隐式目标。Source 的 attention 即使为 immediate，也不使观察地址成为隐式回复目标。

根据外部观察主动沟通时，Agent 仍须独立判断授权，并选择已知的通知目标；指定 target 只是明确目的地，不自动产生授权。助理身份和代理边界见 [Kernel](../kernel.md#助理定位与身份边界)。

`Output.receivers` 是可选的 Person 资源引用列表，与 Input.sender 使用相同引用结构。它记录内容说给谁，target 记录送到哪里：可以在同一个群回复多人，也可以把多处信息整理后向另一个地址的负责人汇报。显式 receivers 覆盖直接回复的默认值，空列表表示不指定个人；仅关联 inputIds 不推导收件人。显式收件人不改变投递数量、不添加群内 @。默认通知固定接收人为 Me，由应用结合所选 Channel 解析其平台身份；其他收件人可以通过 to 与 channelId 解析私聊位置，或明确提供 target。

Channel 地址在 Output 持久化之前还要通过实际投递配置校验：未启用 Lark 或 appId 与机器人 Channel 不一致时拒绝创建，ResourceClient 的组合事务整笔回滚。Connector 观察身份不等于机器人发送身份，不能直接替换 appId 来猜一个可达地址。

地址选择遵循“明确规则 → Agent 判断 → 默认联系 Me”的顺序。多个 immediate 地址冲突或缺失时，不从其中猜一个群；Agent 可以明确选择，无法确定则默认联系 Me。显式指定的无效 target 或缺少 source 的 respondToInputId 仍返回错误，不悄悄改投其他地址。可以为多个 Input 合并生成一个 Output，也可以不关联 Input 而主动通知。Chief 提示词保留当前 Input 地址与 Topic 的来源地址供明确选路；默认通知按 Channel 配置发送，不将 Topic 的来源地址当成默认出口。

Work 的 say 与 Chief 使用同一目的地规则；所属 Topic 只提供业务归属。缺少可用地址时返回错误，不创建无目标 Output；业务 report 与沟通独立，是否已完成应分别核对。

Output 的 `status` 由 Reconciler 维护，记录 pending / sending、尝试次数与最终 delivered；failed / uncertain 为终止或待核对状态，不自动重投。Web 在披露检查完成并准备实际正文后记录 delivered，不表示用户已经阅读。执行成功、业务目标完成、通知创建与外部送达各有独立证据。


## 投递频控

Output 创建不受投递频率限制。Person 的 `spec.delivery` 可配置 `window: { duration: "1h", maxMessages: 10 }` 和 `minInterval: "1m"`；二者独立可选，缺省不限制。时长使用正整数与 ms/s/m/h/d，最长 2147483647ms；窗口最大条数为 1..1000，保证单次统计查询有界。人物页面的“投递”页签可以编辑，修改通过 Person 的正常版本校验保存。

窗口为滑动窗口：最近 duration 内最多成功投递 maxMessages 条 Output；最小间隔从上次成功投递时刻起算。一次 Output 计一条，传输分片不重复计数，失败和不确定结果不计为成功。平台处理延迟与未知结果使实际通知次数无法得到绝对保证。

统计以 `status.delivery.receivers` 的实际 Person UID 为准，跨 Topic、Channel 和 Connector 共享；披露拒绝转告 Me 时只计算 Me 的额度。多人消息需要所有接收人满足条件。Person.status 不存计数，Output 的 delivered 状态与 deliveredAt 是唯一事实来源。`deliveredPerson` 多值有序索引按 Person UID 和 deliveredAt 查询最近 N 条记录；降低额度后同样按第 N 条最新记录计算窗口释放时间，不扫描历史全集。

Output Reconciler 在检查披露后查询额度，未到期保持 pending，通过 requeueAfterMs 进入持久定时协调。`status.deliveryWait` 的 frequency / receiver-busy 仅投影人物等待原因和预计重试时间，不是准入凭据；每次执行重新检查最新策略、权限和记录。provider 则保存外部拒绝给出的最早重试时间，不能被人物策略变更缩短。Person 策略变更按 pendingReceiver 索引唤醒待投递 Output，旧 deadline 不压住新配置。频控等待不增加 attempts，也不记为投递错误。

Host 对实际接收者同时取得执行权，覆盖最终复核、发送与结果落盘。不能全部取得时释放本轮协调并稍后重试，不持有部分人物的执行权，也不积累 Promise 等待队列。不同接收人独立推进；频控时间等待期间不占用执行权。此互斥是单 Host 执行保护，不是持久额度预约，也不承诺多 Host 同库并行投递。

Output 回收在事务内根据当前 Person 策略重查：有效窗口或最小间隔内的成功记录受保护，过期后可按原容量策略回收。启用或扩大频控只使用仍保留的历史，不能恢复此前已回收的投递记录。Person 合并仍保留历史引用原 UID，不改写过去的实际接收者，合并前不同 UID 的历史不自动合并统计。

人物频控独立于下游服务的访问限制、鉴权和投递幂等性；外部频控策略与数值属于各自 Channel / Connector。Channel / Connector 不另建 Person 计数或生命周期；重试仍由同一个 Output 协调。验证见 `tests/output-frequency.test.ts`。
