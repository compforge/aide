# Note

Note 是独立的近期事项资源。Chief 和 Work Agent 用同一个 upsert_note 维护事项；人物关联是 people，输出对象是 subject，不再区分“写 Topic Note”和“写 Person Note”。Topic、Task、Routine、Person 只保存长期 summary，recent 是查询投影。

## 模型与查询

| 字段 | 含义 |
| --- | --- |
| metadata.name / uid | 稳定 Note ID 和具体资源实例 |
| spec.subject | 必填、不可变的 Topic / Task / Routine UID 引用 |
| spec.people | 涉及的人物引用，按 UID 去重；默认空数组 |
| spec.text | 一个事项完整的当前认识，最多 16000 字符 |
| metadata.creationTimestamp | 创建时间 |
| status.updatedAt | 最近一次内容修改时间 |
| status.writer | 本次写入者资源和 executionId，用于事务内授权检查 |

subject 和 people 均有索引。Topic 按自身 UID 查询 Note，相关 Work 的 Note 通过 Work 视图展示；Person 按 people 查询，同一 Note 可以出现在多个人物视图中。不是将正文复制进每个对象。没有配置 owner；引用既不级联删除 Note，也不阻止 Topic、Work 或 Person 回收。Person 合并保留历史 people 引用，不将旧人物证据自动改写成目标人物。

## 工具与并发

upsert_note 的 subject 默认当前 Topic 或当前 Work；Chief 可指定自己当前子树中的 Topic / Task / Routine，Work Agent 只可写自身。people 省略保留已有值，[] 明确清空；不能凭姓名猜测 UID。

不传 noteId 时创建，不需要版本；同一执行内相同 tool-call identity 使用同一 Note 名称，重试返回已有 Note，不能覆盖较新的进展。传 noteId 时必须提交该 Note 的 version，包含 UID 和 resourceVersion。不存在或已淘汰的 ID 拒绝更新。相同内容不刷新年龄或版本。

read_topic、read_task、read_routine、read_person 返回按更新时间排序的 recent 视图；read_note 按 Note ID 返回完整正文及版本。recent 最多 40 条、合计 16000 字符，是展示预算，不截断存储正文。常驻背景进一步缩减为 3 条、每条 500 字符。被截断时先 read_note 再修改，不能把预览当完整原文。

Note 的替换只对该 Note 使用 CAS。不同 Note、调度字段和 summary 互不构成编辑冲突。Note Validator 在事务内核验执行仍活跃、目标仍存在、当前归属仍在写入者范围内。Weave 挂靠后仍在收尾的旧 Chief 可完成自身剩余子树的内容写入，不能越过新的归属边界。

summary 工具使用由资源 UID 和 summary 内容计算的指纹，JSON test 检查旧内容，contextWriter 记录执行依据；领域 Validator 读取实际执行与祖先链。不存在独立持久化的字段版本计数。Person 的 Web 资料整体编辑仍使用资源版本，summary 工具读取 read_person.summaryVersion。

Topic understandingVersion 纳入其查询窗口中 Note 的 UID 和版本。子理解吸收、删除和 Weave 归组在事务中重新查询 Note 索引，避免独立 Note 的新增/修改绕过 Topic 版本检查。Note 单独变化沿用既有策略，不额外激活 Chief；定时 Reconcile 或其它输入激活时读取最新事项。

## 生命周期与容量

Note 没有 TTL，不随 subject 或 people 删除。NoteDefinition 从 updatedAt 提供释放顺序，复用 ResourceStorage 数量配额，例如：

```yaml
resources:
  kinds:
    aide.dev/Note:
      maxCount: 1000
```

达到配额时回收最久未更新的合格 Note，低水位和通用字节限制仍按 [Resource 容量](../plugin/resource.md#resource-容量) 执行。持有长期 summary 的对象不因此被删。显式删除使用标准无外部清理的 Reconcile；容量淘汰直接更新存储和索引。

## 版本与验证

Topic、Task、Routine 使用 aide.dev/v1alpha3，Person 使用 aide.dev/v1alpha2，Note 使用 aide.dev/v1alpha1。旧内嵌 recent 不转换、不双读、不自动清理；部署前另行处理旧数据。

核心场景见 tests/notes.test.ts、tests/topic-persons.test.ts 和 tests/pi-agent.test.ts：独立并发、同 Note 冲突、创建重试、过期执行、祖先归属竞争、悬空历史引用、容量回收、完整读取与真实工具路径。
