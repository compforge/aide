# Person：身份与认识

## 身份、Me 与关系

Chief 持续理解人，并围绕人的目标推进事。Person 是人物 CRD，包含“我”和其他人；Work 是需要持续推进的 Task / Routine。

Person 保存姓名、外部身份和 profile。身份由 provider / scope / id 唯一确定，姓名只用于展示；同一人可绑定多个账号，跨应用的裸 ID 不作比较。外部资料同步只补全尚未识别的名字，不覆盖用户资料或认知。

Person 是人物身份与认知的基础，Me 是附加的可选身份标记：它告诉 Aide，已经识别的人物中哪一个是“我”。Connector 与 Channel 带来的可识别人类身份都按 Person 组织；未配置该入口的 Me 时，仍正常接收和处理 Input、识别人并积累人物认知。配置 Me 后，Aide 才能将该入口中的身份认作本人，并结合其他已绑定身份形成跨入口的本人认知。

访问授权与本人标记分别声明：Connector 的执行身份决定能访问哪些数据，Me 通过匹配 Person 的外部身份确定 Personal.me。以 Lark 为例，外层 appId / userId 校验 CLI 使用的应用与已授权用户，实际凭证由 CLI 管理；me 中的 appId / openId 标记该应用下哪个人是本人，不授予访问权限。执行账号可能属于另一个人，不能从登录凭证推导本人。本地单人 Web 有固定身份 web / local / me。配置标记在启动时绑定到同一个 Person，冲突会报错。

Person 目录属于 Personal 插件实例，由各 Topic 共享。资源与引用不携带 sessionId，目录不启动 Harness；Person Controller 只参与标准删除生命周期，无外部清理动作。人物资源受容量保护，ResourceClient 写入在同一存储事务内做版本、Schema、身份唯一性与 Me 约束校验，包括批量 commit。

Channel、Source 和按需 Connector 消息读取持续贡献人物事实。发送者及上下文中的作者拥有可识别用户身份时解析为 Person；缺少主体类型的提及 ID 保留为证据，避免把机器人建成人物；系统事件不需要人物。Input.sender 是可选的 Person 引用，多作者讨论没有单一发送者时留空，逐条作者保留在 observation 中。Output.receivers 同样引用 Person，可以为空或包含多人；Input.source 与 Output.target 使用 Address。Aide 结合输入性质、已有委托与处理进展，决定是否沟通、对谁表达、送到哪里；这些决定不要求与单条 Input 一一对应。

Input.relation 描述输入相对于 Me 的关系：

| 值 | 含义 |
|---|---|
| sent | 我发出；仍需识别引用与代发内容 |
| received | 明确发给我，如 @、回复本人，或执行账号确属本人时的私信 |
| observed | 来自本人的观察范围，不证明实际已读 |
| 缺省 | 身份或关系依据不足 |

Web 输入为 sent。别人私信机器人或仅 @ 机器人不能据此认定为我收到；Lark Source 对各条消息分别分类，混合讨论仅在本人的观察范围内归为 observed。环境与需求监控属于配置的观察范围。关系随 Input 持久保存，不因后续身份编辑而改写历史。

## 认识与用户修正

Person 的 status.summary 保存当前认识概览，status.recent 保存近期交往、观察和认识修正的依据；区分明确表达和推断，保留必要背景与日期，不引用 Input ID。Chief 的 summary_person 工具更新 summary 并追加 recent；用户在 Web Persons 直接编辑同一个 status.summary，修正后的文本就是当前认识。recent 只记录发生过用户修订，不复制整篇 summary。Chief 必须读取最新版本并在继续维护时尊重用户明确修正，不能用旧上下文中的推断覆盖它。身份补全、仅编辑身份和启动更新均保留现有认识。并发更新必须重读后合并，不能盲目覆盖。

summary 和 recent 只是人物资料的一部分，不代表完整的长期 profile。职责、关系、经历等资料可以按其自身语义继续组织；近期窗口的裁剪不授权删除长期资料。

人物工具沿用 Work 的接入方式：模型工具调用 Personal 服务，再经 ResourceClient 更新 CRD，无需新增 Core verb 或人物输入队列。读取、补充、合并、纠错在正常 Chief 轮次内发生，Topic 摘要仍只维护话题窗口。详见 [Chief](chief.md#人物认知)。

## 用户合并人物

Persons 详情展示 `spec.name` 完全相同的其他人物，每项仅展示外部身份列表，右上角提供「合并」按钮。同名只提供候选，不证明是同一个人；Connector 始终按 provider / scope / id 匹配。用户在当前人物 B 的详情中选择 A 的「合并」，在弹窗核对双方身份与认知后确认 A → B；有未保存修改时先保存或取消。

合并保留 B 的资源 ID 和姓名，将 A 的外部身份去重追加到 B。当前认识保留双方不同的非空内容，用户可在确认时修订；超过 summary 上限时要求精简，不静默截断。近期依据按时间合并并沿用现有窗口，追加用户合并记录。涉及 Me 时保留 Me，将其他人物合入 Me。

`Persons.merge` 校验双方 UID 和 resourceVersion，通过 `ResourceClient.commit` 原子提交 A 的删除请求与 B 的更新；删除标记先于身份追加校验，事务外不会看到身份转移的中间状态。任何失败全部回滚，提交后才通知 Watch；Person 的标准 Reconcile 随后 finalize A，重启后也会继续。A 不保留别名或 mergedInto 记录。

Input.sender / Output.receivers 是允许悬空的历史引用，不保证 Person 存在。合并不改写历史 Input/Output，也不将 A 的引用重定向到 B。读取缺失人物时保留消息正文和已有来源证据；引用带 UID 时必须校验，避免把重建的同名资源认作旧人物。后续输入按已转移的外部身份匹配 B。

## 验证

`tests/person-catalog.test.ts` 覆盖身份唯一性、Me、版本检查和用户编辑；`tests/person.test.ts` 与消息 Source 测试覆盖关系归因。Chief 的人物工具与记忆验证见 [Chief](chief.md#验证)。

`tests/person-merge.test.ts` 覆盖合并方向、同名独立、事务回滚、并发合并、Connector 身份重查与历史悬空引用；`tests/person-catalog.test.ts` 验证 HTTP 合并、标准 finalize 与重启后的身份归属。
