# 披露边界

Aide 服务于 Me。Chief 可结合全部已有 Note 与最新 Input 生成正文和引用列表；Output Reconciler 决定这段正文能否送到原目标。Me 的已确认私有目的地可接收全部信息；写 `receivers=[Me]` 不会把群聊变成私有目的地。

本次资源契约为 Input v1alpha5、Note v1alpha4、Output v1alpha5。不读取或转换旧版本资源，遵循 [资源版本约定](../plugin/resource.md#api-版本与演进)。

## Note 分类与接收者

普通 Note 与 summaryOf Note 使用相同的 `sensitivity: L1 | L2 | L3` 和 `visibility: people | topic | root | any`。Person 的 `clearance` 表示允许接收的最高密级。创建 Note 时可省略分类，存储默认 L3/people；Person 默认 L1。Input 只保存输入事实，不建立第二套分类。

Note 正文、people、sensitivity、visibility 可以独立修改，也可以一次提交。upsert_note 更新时只需给出要改的字段，省略保留原值；新建必须提供正文。摘要 Note 通过同一接口修改，事务内同步所属对象的摘要指纹。summarize_topic 可只更新分类，也可同时确认 absorbed 子主题版本，两种效果都必须落盘。Person 摘要允许 topic/root 分类；范围无法解析只影响对外投递，不妨碍内部认识更新。

- people 使用 Note.people；不另设来源人物字段。
- topic 使用 Note 当前 subject 对应 Topic 的显式 `spec.people`。Task/Routine 通过所属 Topic 解析；Person 没有隐式所属 Topic。
- root 沿该 Topic 的 parent 找当前 root，使用 root 的显式 `spec.people`。
- any 不限制参与范围，仍检查 clearance。

`people` 和 `receivers` 按 Person UID 集合表达，存储时统一去重、排序。人物顺序或重复项变化不改变含义，也不会改变披露指纹、发送意图或重试投递；实际成员或权限变化仍会重新检查，已尝试的投递不可更换接收者。

没有额外授权锚点。move_note、工作归属与 Topic parent 变化会影响下一次检查；删除或无法解析的关系不能凭空授予权限。既有 Note 的 Agent 更新不能降低 sensitivity；合成或匿名化不是降低密级的理由。Person 合并摘要保留最高 sensitivity，不同 visibility 需要先统一分类。

Me 在人物页面编辑 clearance；主题参与者通过 `POST /topics/people` 设置 `{id,uid,version,people}`。近期人物预览不是完整参与名单。people 范围是产品采用的近似策略，不是来源证明或严格的信息流追踪。

## Output 策略

`output/policy.ts` 集中实现 `policy(note list) → {sensitivity, visibility, people}`，策略与检查、发送、重试的生命周期分开。当前规则：

1. sensitivity 取所有引用 Note 的最高值。
2. visibility 取较窄类型，顺序为 people、topic、root、any。
3. people 类型使用所有引用 Note.people 的并集；接收者出现在任意一份 Note.people 即满足范围。
4. topic/root 类型使用设定该类型的 Note 所解析参与名单的并集；无法解析时不外发。any 没有成员限制。
5. 每个实际接收者都须满足计算出的范围与密级；Me 豁免。已确认私有且未禁言的 Me 目的地不要求材料引用或模型校验。

混合范围的合成规则属于可调整策略，并不声称 people/topic/root 的实际成员集合天然包含彼此。后续策略变更集中在此处；已送达内容不追回，也不会自动重发。

## 生成与检查

`say` 原子创建邮件和投递任务。Output 保存不可变的 stream（UID 引用）、target、receivers，以及可选的 Input 追溯信息；notes 转为 Stream.status.references（UID、读取版本与正文指纹）。实时生成通过 cite_output 补充引用，关闭后冻结。真正使用的近期和长期 Note 都应引用；对外正文使用新 Input 的事实时，先将相关事实整理到可引用、可分类的 Note。仅向 Me 沟通不强制先写 Note。工具只确认已接纳，不确认送达。

写入引用时核对 Note 读取版本，并单独固定引用 Note 的正文指纹。发送前读取当前分类：分类变化触发重新计算，正文修改或 Note 回收导致引用失效。`status.disclosure.policy` 保存本次计算结果，fingerprint 标识材料、组织关系、人物与实际受众等依赖。

Reconciler 检查 Address 的已知参与者、禁言设置和计算出的权限，再委托内容 checker 解释邮件协议并使用隔离 Pi 校验正文、思考与工具证据是否受引用支持。模型复用 Chief 配置，禁用环境上下文、skills 和外部工具，材料预算 100000 字符，最多 30 秒。无有效引用、没有已知参与者、失效人物、地址禁言、模型不可用或校验拒绝都不外发。引用一致性校验无法保证所有背景信息都已被引用。

Web 是 Me 的私有界面。Lark 私聊按 app/open_id 或已观察的私聊人物解析；群聊按 Address.people 的已知参与者检查，不要求完整名单、不额外请求所有群成员。这是用户选择的近似边界，未知旁观者、机器人和转发不在保证内。Address 不另设 sensitivity / visibility，内容分类来自 Note，人物权限来自 clearance；参见 [Address](address.md)。

## 一个 Output 的投递生命周期

`spec` 永久保留原意图。`status.disclosure` 保存 decision、reason、checkedAt、fingerprint 和计算策略；`status.delivery` 保存实际 target、receivers、stream、confirmedSeq 及 transport 的 replay 约定；phase、attempts、receipt 表示实际投递状态。

Output Reconciler 是检查、投递和重试的唯一协调者。底座按资源串行、不同资源并发，并负责错误退避和重启恢复。Channel/Connector 仅提供具体目的地的 transport，不遍历 Output，也不维护业务重试定时器。Lark 管理入站与固定错误提示，进度卡仅消费 Reconciler 选定的实际 Stream。

Chief 只提交 raw Output，Reconciler 根据策略选择实际 target/stream，允许则投递原文。原目标禁言时，关联的精确 Input UID 中存在 Immediate Input（包括 Channel 的默认 Immediate）才将实际正文替换为固定话术“我当前被禁言。如需听我发言，请解除该地址的禁言。”，发送到原计划被禁言的 Address，保留回复坐标；不携带原文、引用材料或其它生成内容。实际投递持久化 notice=muted，投递层验证固定系统邮件的 UID、Output owner 与终态后，向 Channel 提供禁言许可；无需通过解析正文识别提示。原 spec 与 Address.muted 保持不变。Input 缺失、UID 不符、Normal、Deferred 或没有关联 Input 时均不获得这一例外。

非 Immediate Output 遇到禁言时改投 Me 的 defaultAddress，复用 raw Stream。其它拒绝在同一 Output 上创建替换 Stream，通过 defaultAddress 私下通知 Me：“原计划给谁发什么、因为什么未发送”。不新建通知 Output。默认地址暂不可用时保留 pending/error，由此 Output 自己重试，不阻断其它 Output。

异步检查完成后重新核对依赖；transport 准备完成后再检查一次，再记录 sending 并调用发送。被拒绝的原意图不会因权限放宽自动恢复外发；已经保存的禁言提示在 Input 回收、解除禁言或重启后仍只重试该提示。开始尝试后实际正文、目的地与接收者不可改变；变化使原投递无法继续时转 uncertain，核对外部回执。

幂等 transport 使用同一 Output ID 重试；Lark 按稳定分段 UUID 和本地回执续传。非幂等 transport 发送结果未知或进程中断后转 uncertain，不盲目重发或转投。Requirement 回读匹配目标、正文和投递标记后可恢复 delivered。提供方去重窗口之外不能承诺恰好一次。送达清理 lastError，运行时掌管退避时间，Output 不另存 nextAttemptAt。

网络无法把本地权限快照与远端群成员变化纳入同一事务。Web 的 delivered 代表发布完成，不表示用户已阅读。私密 Me 地址可持续展示实际 Stream 的 think/text；外部地址等待终态并对正文、思考和工具证据一起检查后才能发送。页面按原始正文去重，再装饰投递状态标签。

## 验证

`tests/output-disclosure.test.ts` 覆盖 Me 例外、people 并集、当前分类、动态归属、正文失效、异步检查期间权限变化与同资源转告。`tests/output.test.ts`、`tests/requirement-output.test.ts`、`tests/lark.test.ts` 覆盖失败隔离、幂等续传、回执恢复与非幂等发送不确定性。`tests/summary-notes.test.ts` 验证分类独立编辑及摘要依赖一致性。

Person 引用集合在 Resource 的 TS 字段中使用 `KeyedSet<PersonRef>`，按 UID 判断成员身份；Note.people、Topic.people、Input.receivers、Output.spec.receivers 与 Output.status.delivery.receivers 共用这一契约。持久化和对外 DTO 使用规范顺序的数组，重复项和顺序不改变披露指纹或重试目标。
