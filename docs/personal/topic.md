# Topic

Topic 把同一主题下的输入、认识、工作和沟通放在一起。例如一项供应商准入可以跨群聊和工单：Input 保留每次变化及来源，Person 和 Address 标明涉及谁、发生在哪里；审批还有下文就用 Ongoing 跟进，核实出的准入规则可以记为 Note，发出的询问由 Output 留下记录。同一个人物或场合可以出现在多个主题里。[Personal 数据与处理流程](README.md)

## 材料归属与处理责任

### TopicLocator 能力

Topic 有两种来路。外部来源可在 Input 上带稳定的 `topicKey`，比如某个仓库或 Lark 群话题。Channel 或 Source 的 locator 只提供定位线索。入站先按 Input 身份去重，Route 再按 key 复用或创建 Topic；并发接纳同一 key 只绑定一个可接纳实例。显式选择已有 Topic 时可直接给 `topicId`。来源建议的名称只用于新建时展示。[定位接口](../../plugins/personal/topic/locator.ts) · [来源规则](route.md)

Aide 也可以自行组织 Topic。没有明确定位线索的 Input 由 Route 在当前主题中选择归属；Chief 可以在责任树内创建子主题，Weave 可以为相关领域建立共同父主题。已有来源 key 继续指向原节点，后续输入仍然找得到它。[Weave](weave.md)

### 默认主题

没有合适归属的输入进入 Default。系统首次需要时创建并持续复用这个领域 root。Default 可以有子主题，受保护、不可删除，也不参加 Weave 归组。主动联系 Me 的地址由 Channel 单独确定。[默认通知地址](../channel/README.md#默认通知地址)

## CRD

`aide.dev/v1alpha5 Topic` 有独立 ID 和 UID。树只保存指向父 UID 的 `spec.parentRef`，直接子节点由索引反查。Gate 是唯一无父节点的 Topic；Gate 的直接子节点是领域 root。每个领域 root 的 Chief 处理其子树的材料，子节点之间可以分别保存局部认识。[Topic 模型](../../plugins/personal/topic/model.ts) · [Chief 接纳与执行](chief.md#reconciler)

### 归属调整与责任交接

每个 Input 只有一个当前 Topic，首次路由、原始证据与处理回执可以追溯。Task、Routine 和 Input 用 `status.topic` 保存当前归属，Ongoing 通过 `spec.topic` 关联主题。Note 通过 subject 或相关人物、地址提供认识；Output 使用实际回复地址或显式目标投递。树上的位置不赋予额外权限。[Input](input.md) · [Ongoing](work.md#ongoing) · [Output](output.md)

Chief 可移动材料或调整子树，Weave 可组织领域 root。改变父子关系保留材料的直接归属；单独移动材料保留身份及回执，已完成的 Input 不会因此再次消费。结构写入在事务内核验操作者、祖先链、环和在途执行。Chief 移交子树需等到安全点；Weave 归组时旧执行可以收尾，后续处理由新 root 接手。[树内整理](chief.md#按-input-选择工具) · [跨领域组织](weave.md)

## 主题认识与汇总

普通 Note 保存事实和方法。每个 Topic 的 Summary Note 提炼下次处理这个主题时值得默认读到的认识，`status.summaryRevision` 保存其内容指纹。父主题可综合子主题的结论，保留来源与分歧。业务活动时间 `lastInputAt` 从子节点异步向上传播；阅读、梳理和修改摘要不刷新它。[Note](note.md) · [Secretary](secretary.md)

## 生命周期

### 回收资格

释放静默 Chief 会话会保留 Topic。容量不足时，底座按最后业务活动时间检查叶子节点；没有 Input 时使用创建时间。Gate、Default 以及持有会话、执行、错误或子节点的 Topic 受保护。待处理的 Input、仍归属该主题的 Task 或 Routine、开放的 Ongoing 也会阻止回收。有知识的叶子还需要 Chief 针对当前 `reclamationVersion` 记录释放理由，Note 内容或归属变化会使旧许可失效。没有安全候选时，底座拒绝超限写入。[资源容量与释放](../plugin/resource.md#resource-容量与释放)

复核回收时应覆盖嵌套子树、重启后继续协调，以及签发许可后又有新材料到达的情况。删除在事务中重新检查依赖。新输入以后可以用同一 key 创建新的 Topic，其 UID 独立；历史证据继续引用原实例。

### 验收

[接纳测试](../../tests/topic-intake.test.ts)覆盖输入接纳，[归属测试](../../tests/topic-ownership.test.ts)覆盖树调整与并发，[默认主题](../../tests/default-topic.test.ts)和[删除测试](../../tests/topic-delete.test.ts)覆盖保护条件；跨领域组织见 [Weave 场景](../../tests/weave.test.ts)。
