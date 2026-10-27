# Person：身份与认识

## 身份、Me 与关系

Chief 持续理解人，并围绕人的目标推进事。Person 是人物 CRD，包含“我”和其他人；Work 是需要持续推进的 Task / Routine。

Person 保存姓名、外部身份和 profile。身份由 provider / scope / id 唯一确定，姓名只用于展示；同一人可绑定多个账号，跨应用的裸 ID 不作比较。外部资料同步只补全尚未识别的名字，不覆盖用户资料或认知。

Person 是人物身份与认知的基础，Me 是附加的可选身份标记：它告诉 Aide，各个接入中的哪些账号代表“我”。Connector 与 Channel 带来的可识别人类身份都按 Person 组织；未配置该入口的 Me 时，仍正常接收和处理 Input、识别人并积累人物认知。配置 Me 后，Aide 才能将该入口中的身份认作本人，并结合其他已绑定身份形成跨入口的本人认知。

访问授权与本人标记分别声明：Connector 的执行身份决定能访问哪些数据，每个 Channel / Connector 的 Me 配置在自己的平台身份范围内生效，Person 的 isMe 汇总这些标记。以 Lark 为例，外层 appId / userId 校验 CLI 使用的应用与已授权用户，实际凭证由 CLI 管理；me 中的 appId / openId 标记该应用下哪个人是本人，不授予访问权限。执行账号可能属于另一个人，不能从登录凭证推导本人。本地单人 Web 有固定身份 web / local / me。配置按接入分别保存，Person 按现实中的人归一。Lark、WeChat 等接入都配置 Me，就明确声明这些账号属于同一个人。启动时按平台身份查找已有档案，优先保留持有本地 Web 身份的 Person，否则保留最早创建的匹配档案；没有匹配档案时创建一个 Person，并绑定全部已配置身份。已有多个档案时，在同一事务中归并身份、summary 和有界 recent，再删除来源档案；重复启动不重写未变化的数据。历史引用沿用下述人物合并规则。未配置某个入口的 Me，不从登录凭证或其他入口的标记推断。合并后的 summary 或身份数量超过 Person 上限时，保留全部原档案、记录待归并错误并继续启动；用户精简认识或调整身份后可显式合并，不为自动归并丢弃已有认识。撤掉某个 Me 配置只停止该入口的本人识别，不自动拆开已经确认同一人的档案。

Person 目录属于 Personal 插件实例，由各 Topic 共享。资源与引用不携带 sessionId，目录不启动 Harness；Person Controller 只参与标准删除生命周期，无外部清理动作。人物资源受容量保护，ResourceClient 写入在同一存储事务内做版本、Schema、身份唯一性校验，包括批量 commit。

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

Person 的 status.summary 保存长期有效、低频变化的人物认识，status.recent 保存可持续更新的近期事项 Note。Chief 通过 summarize_person 只修订 summary，通过 upsert_note 显式选择 Person 创建或更新 Note；共用[有界认识契约](README.md#有界认识与近期依据)。用户在 Web Persons 直接编辑同一个 status.summary，updatedBy 保留用户来源，Note 原样保留；后续只改 Note 也不改变 summary 的修订来源和时间。Chief 必须读取最新版本并尊重用户明确修正，不能用旧上下文中的推断覆盖它。身份补全、仅编辑身份和启动更新均保留现有认识。并发更新必须重读后合并，不能盲目覆盖。

summary 和 recent 只是人物资料的一部分，不代表完整的长期 profile。职责、关系、经历等资料可以按其自身语义继续组织；近期窗口的裁剪不授权删除长期资料。

人物工具沿用 Work 的接入方式：模型工具调用 Personal 服务，再经 ResourceClient 更新 CRD，无需新增 Core verb 或人物输入队列。读取、补充、合并、纠错在正常 Chief 轮次内发生，Topic 摘要仍只维护话题窗口。详见 [Chief](chief.md#人物认知)。

## 用户合并人物

Persons 详情按 `spec.name` 精确查询其他同名人物，候选独立分页，不依赖导航当前页；每项展示认识预览和「核对并合并」入口。同名只提供候选，不证明是同一个人；Connector 始终按 provider / scope / id 匹配。用户在当前人物 B 的详情中选择 A 的「合并」，在弹窗核对双方身份与认知后确认 A → B；有未保存修改时先保存或取消。

合并保留 B 的资源 ID 和姓名，将 A 的外部身份去重追加到 B。当前认识保留双方不同的非空内容，用户可在确认时修订；超过 summary 上限时要求精简，不静默截断。近期 Note 保留稳定标识、按更新时间合并并沿用窗口；身份合并本身不追加事项笔记。Me 档案同样允许显式合并；标记跟随保留下来的平台身份生效，不限定合并方向。编辑人物时不能直接移除当前已配置的 Me 身份；先修改对应接入的配置，或通过合并转移身份。

`Persons.merge` 校验双方 UID 和 resourceVersion，通过 `ResourceClient.commit` 原子提交 A 的删除请求与 B 的更新；删除标记先于身份追加校验，事务外不会看到身份转移的中间状态。任何失败全部回滚，提交后才通知 Watch；Person 的标准 Reconcile 随后 finalize A，重启后也会继续。A 不保留别名或 mergedInto 记录。

Input.sender / Output.receivers 是允许悬空的历史引用，不保证 Person 存在。合并不改写历史 Input/Output，也不将 A 的引用重定向到 B。读取缺失人物时保留消息正文和已有来源证据；引用带 UID 时必须校验，避免把重建的同名资源认作旧人物。后续输入按已转移的外部身份匹配 B。

## 验证

`tests/person-catalog.test.ts` 覆盖身份唯一性、Me、版本检查和用户编辑；`tests/person.test.ts` 与消息 Source 测试覆盖关系归因。Chief 的人物工具与记忆验证见 [Chief](chief.md#验证)。

`tests/person-merge.test.ts` 覆盖合并方向、同名独立、事务回滚、并发合并、Connector 身份重查与历史悬空引用；`tests/person-catalog.test.ts` 验证 HTTP 合并、标准 finalize 与重启后的身份归属。
