# 披露边界

Aide 服务于 Me。已有 Note 与最新 Input 可用于内部判断，但对外沟通必须同时满足材料密级与披露范围。Me 的已确认私有目的地可接收全部信息；写 `receivers=[Me]` 不会把群聊变成私有目的地。

## 材料与接收者

Note（包括 summaryOf Note）与 Input 使用 `sensitivity: L1 | L2 | L3` 和 `visibility: people | topic | root | any`。Person 使用 `clearance`，表示允许接收的最高密级。未分类材料默认 L3/people，未配置人物默认 L1；缺失权限事实不视为公开。Input 的事实和分类在接纳后不可修改。

- people：Note.people，或 Input 的已知 sender/receivers。关联人物是本产品采用的近似披露范围，不代表信息来源的严格证明。
- topic/root：创建或显式分类时解析为固定 UID 的 `disclosureScope`，使用该 Topic 的显式 `spec.people` 参与名单。root 名单由 Me 明确维护，不从整树近期提及人物推导。
- any：不限制参与范围，仍检查 clearance。

组织归属与授权锚点独立。move_note 和 Weave 调整 parent 不改 disclosureScope；原授权 Topic 删除或换 UID 后，权限无法确认，不能对外发送。改变范围必须是显式分类动作。既有 Note 的 Agent 更新不能降低 sensitivity；摘要、匿名化、压缩都不是解密理由。Chief 必须保留合成材料的限制，系统默认保守；目前不建立逐句依赖图，不能声称已证明所有推导信息的权限继承。

Person 合并摘要时保留最高 sensitivity；不同 visibility 或授权锚点不能静默合并，需要先明确统一分类。

Me 在人物页面编辑 clearance；主题参与者通过 `POST /topics/people` 设置，参数为 `{id,uid,version,people}`，使用当前资源版本防止覆盖并发更改。参与授权独立于 Note.people 和有界的 topicPersons 预览；Chief 的语义关联不会自动授权。

## 生成与投递

`say` 提交不可变的发送意图：text、target、receivers、notes（UID 与内容版本）以及 Input 的名称与固定 UID。所有真正使用的近期和长期 Note 都要引用。工具只确认已接纳，不确认送达。

Output Reconciler 使用底座的按资源串行队列，调用 Personal 的披露能力。它检查完整实际受众、每份材料的密级与范围，再用隔离的 Pi 校验检查正文是否得到引用支持。该校验复用 Chief 的模型配置，禁用环境上下文、skills 和外部工具，材料预算 100000 字符，模型阶段最多 30 秒。无引用、引用失效、受众不完整、模型不可用或校验拒绝都不允许外发。

Web 是此单用户产品的 Me 私有界面。Lark 私聊按 app/open_id 解析人物，chat/thread 通过已配置 Channel 的 SDK 分页查询成员，最多 10 页。名单不完整或有人物无法解析时不外发。Lark 的成员接口只覆盖平台返回的人类成员，此机制不承诺对未知机器人、转发或截图形成绝对控制。Requirement 当前没有完整受众能力，原目标不能通过检查，转告 Me。

多份材料逐份核对，等效于最高 sensitivity 与允许受众的交集。模型的引用一致性检查只是补充，无法证明引用没有遗漏所有潜在背景信息。

## 一个 Output 的状态

`spec` 永久保存原发送意图。`status.disclosure` 保存 decision（allowed/denied）、reason、checkedAt 和所依赖事实的 fingerprint。`status.delivery` 保存实际 target、receivers、text；现有 `status.phase/attempts/receipt` 继续表示这一次实际投递的生命周期。

允许则实际投递原文。拒绝则解析 defaultChannel，确认是 Me 的私有地址，实际投递“原计划给谁发什么、因为什么未发送”。不新建通知 Output，也不单独维护 notification 状态。默认渠道无法确认或暂不可用时保留 pending/error，由 Reconciler 重试。

检查完才持久化实际投递。异步校验后重读材料、人物与受众，在事务内核对依赖后提交；发送前重新检查。已拒绝的意图不会因后续权限放宽自动恢复外发。开始过投递后，实际正文与目的地不可改写；权限变化导致无法继续时标记 uncertain，先核对外部回执，不重定向已有部分发送。网络系统无法把本地权限快照与远端群成员变化纳入一个原子事务。

Web 创建 Output 不再直接标记送达。Channel 仅消费已检查的实际投递，Lark 进度卡不展示私有思考和工具内容，也不提前消费待发 Output；已送达正文可以在对应进度卡中镜像展示。

页面区分原意图与实际结果：被拒绝并已转告 Me 时，显示“已转告 Me，原目标未发送”。Output、Input、Note 的引用是历史依据，不形成容量保留边；引用已回收但消息尚未检查时，不能凭空恢复许可。

## 验证

`tests/output-disclosure.test.ts` 覆盖未检查拦截、Me 私有例外、正常发送、同资源转告、密级与范围交集、失效引用、校验异常、校验期间权限变更、通知重试和已尝试发送后的不确定状态。渠道测试继续验证幂等、接收地址、外部回执和重启恢复。
