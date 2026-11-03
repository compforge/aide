# Address：沟通场合

Address 是 Personal 的独立资源，表示一个群聊、私聊、Web 收件处或外部系统位置。Person 回答“谁”，Topic 回答“什么事”，Address 回答“在哪说”；Channel / Connector 提供实际发送能力。群聊可以承载多个 Topic，一个 Topic 也可以涉及多个场合。

## 字段与发现

`spec.locators` 是按规范 locator 去重的 KeyedSet，保存同一场合的多个定位方式；它们地位平等，数组顺序不表示投递优先级。`name` 和 `type` 描述场合；`muted` 表示是否禁止 Aide 在此发言。新发现的外部地址默认禁言，Web 和根据已配置 Lark Channel 的人物身份发现的单聊地址首次创建时允许发言。后续 Input、启动或发送准备不会覆盖用户已经设置的 muted。

`status.people` 是按 Person UID 去重的 KeyedSet。Input 接纳时根据发送者、明确收件人和上下文中已确认的人物持续积累；它不是完整或实时的群成员名单。不保存 audienceComplete、audienceObservedAt，也不为积累成员额外遍历平台通讯录。Person 合并时保留参与者迁移来源，由 Reconciler 分批转移 Address 的当前成员关联，历史 Input/Output 人物证据不改写。

Input.source、Topic.spec.address、Output.spec.target 保存固定 UID 的 AddressRef。Connector / Channel 边界仍可提交平台 endpoint，由接纳层统一解析为资源引用。来源适配器显式提交场合名称、类型、已知人物和回复坐标，Input 存储不解析 observation 来猜这些信息。Lark 同一 app/chat 的普通消息和多个 thread 共用一个 Address；原消息 ID 单独保存在 Input / Output 的回复坐标中。

Lark bot 单聊的 `open_id` 和入站 `chat_id` 可以是同一场合的两个 locator，locator 索引覆盖两者。当前多 locator 仅支持同 app 的 Lark direct chat/open_id 对；其它地址保留单 locator。只有 Channel p2p Input 中的 app、chat、人物身份一致时才证明该关系；Connector 观察到的人与人私聊不能据此绑定。投递适配优先使用已确认的 chat_id，只有 open_id 时通过它主动联系；回复坐标仍独立保存在 Input / Output。

## 归并与生命周期

Input 先持久接纳，再唤醒 Address Reconcile。已有两个独立 Address 时，保留已观察的 chat Address UID，将另一个标记为 retiring，并在保留资源上记录 status.mergeSources 作为可恢复的工作进度。同一事务中存续 Address 接管全部 locators；locator 索引排除 retiring 资源，使新联系查询立即命中存续 UID。参与者取并集，禁言取更严格值；这些状态不构成 redirectTo。新 Output 和联系人发现不再选择 retiring 资源，已有 Output 的目标及投递事实不改写。

Reconcile 分批迁移 Topic 当前地址和 Note 场合关联，更新显式 defaultAddress。遇到 pending、sending、uncertain Output 时等待处理完成，不删除其仍依赖的 Address，也不改投或重发。合并独立摘要时，保留每份 Note 的 UID、正文、分类与原 summaryOf，通过存续 Address 的近期关联发现它们；不拼接正文或降低敏感度。事务只改变关联，不以失效的历史执行重新写内容。

当前引用排空后，给重复 Address 请求标准删除；Controller 随后完成实际删除。重启按 mergeSources 继续，人物联系地址由身份查询自然得到，无需改写 Person。历史 Input 和已完成 Output 保留原 UID，允许成为悬空历史引用，不自动重定向。

Schema 严格使用 locators；旧 endpoint / aliases 字段不读取、不迁移。

## 对场合的认识

Address 的长期认识是 `Note.summaryOf = AddressRef` 的普通摘要 Note，保存场合用途、角色、交流习惯以及仍待确认的信息。它具有 Note 的 people、sensitivity、visibility，可被 Output 引用；Address 存在时不参与普通 Note 配额回收。

近期事项通过 `Note.addresses` 的 UID 集合关联同一场合，按更新时间分页查询。事项仍保留原 Topic / Work subject；同一 Note 可以同时出现在多个场合中，无需复制正文。场合认识不自动授予发送权限。

Chief、Task、Routine 通过 list_addresses / read_address 了解场合，通过 upsert_note 的 addresses 关联各自近期事项。Address 的共享长期认识由 Chief 通过 summarize_address 更新；Task / Routine 只修改自身内容。Agent 工具不提供解除禁言能力。

## 答复与投递

Chief 选择内容、收件人物及目标 Address，合适时优先原处答复。respondToInputId 指明正在回答哪条消息，可同时指定 target 选择另一个场合；它与 to 互斥。Channel 请求和 Lark Source 的原始群内 @Me 消息可以走这一入口，普通观察及单聊采集不自动产生代答入口。

Source @Me 和 Channel @Aide 以 app/chat/message 作为同一原消息身份，在事务中限制为一份明确答复 Output；同一工具调用仍检查不可变发送意图。该约束覆盖保留中的答复记录，不声称超过历史回收窗口后仍恰好一次。观察到 Me 对原消息的明确回复或原消息撤回证据时，尚未尝试的答复转 cancelled；无关发言不取消。已经尝试的投递保留原有不确定性和重试规则。

Output Reconciler 检查 Address 是否禁言，并按已知 people 逐个检查 clearance 和引用 Note 算出的披露策略。空名单或失效身份不能授权外发；已确认私有 Me 地址保留内容豁免，但仍遵守 muted。禁言时，关联 Immediate Input 的 Output 在原目标以固定禁言提示替换正文；其它 Input 或无 Input 的 Output 通过 defaultAddress 私下告知 Me 原计划、正文及原因。其它披露拒绝同样私下告知 Me，具体规则见 [披露边界](disclosure.md)。不会自动改投另一个外部场合。

Output.status.delivery.address 固定实际 Address，target 保存具体投递坐标；等待默认地址可用时保存 waitingAddress。原目标、实际地址和等待地址共同参与 pendingAddress 索引，Address 政策或成员变化按索引唤醒待发 Output；异步检查和 transport 准备后重查，实际发送边界再核验禁言。平台请求已经发出后不能撤回既有副作用。除 Output Reconcile 持久化的 Immediate 禁言提示外，禁言同时约束 Lark 进度卡、Channel 固定错误提示和长消息后续分片，不影响接收与积累认识。

## Web 与验证

共享连接与凭证通过配置文件维护。Addresses 列表中每个地址的三点菜单提供设为默认通知地址、禁言或解除禁言；小房子图标标记默认地址，禁言图标标记 Aide 已被禁言，悬停可查看含义。列表标题旁的刷新图标重新读取地址和默认设置。默认未配置时使用稳定的 Me Web 收件处。连接调整重启生效，默认地址选择立即用于新通知。

Addresses 页面通过上一页 / 下一页展示场合，每页 10 条普通地址；默认通知地址固定置顶，不占分页名额或普通地址总数。`GET /addresses/list` 使用 `page` / `pageSize`，返回 `items`、`pinned`、`total`、`page`、`pageSize`、`pages`；服务端先排除已删除及置顶地址，再按创建时间和资源键倒序分页。页码保存在 URL 中，未指定页码的详情链接通过 `selectedUid` 定位所在页；刷新和修改默认地址保留当前页，越界时收敛到最后一页。翻页不关闭详情或覆盖认识草稿。Agent 的 `list_addresses` 继续使用 `continue` 游标。

详情提供认识、近期记录、参与者三个子页。Me 可以禁言/解除禁言、编辑当前认识；保存按实际编辑字段检查并发冲突。参与者展示已知人物，不表示群成员已收集完整。

验证见 `tests/address-resource.test.ts`、`tests/default-address.test.ts`、`tests/lark-progress.test.ts`、`tests/person-merge.test.ts`。Input、Output、Note 的资源版本随本次持久契约更新；不提供旧数据迁移。旧版本不读取，部署前需要按资源契约重建不兼容数据及其摘要依赖，不能直接混用旧摘要指纹与新版本 Note。
