# Stream

Stream 是带 Resource 身份、结构性 owner 和终态的追加记录，使用 `aide.dev/v1alpha1 Stream`。
底座负责存储和生命周期，不解释正文，也不认识 Person、Address、Note 的权限或禁言。

`metadata.owner` 必须携带 owner UID；同名重建不继承数据。`spec.protocol` 标识邮件协议，创建后不可变。
`status` 保存 `phase: open | completed | interrupted`、`lastSeq` 和 `references`；终态还保存
`closedAt`，异常终止可保存 `error`。引用是元数据，带资源类型、UID、读取版本及可选正文指纹；
不形成 owner 边，不让被引用的 Note 随 Stream 删除。关闭后记录和引用都不可再修改。

正文按 Stream UID 存在独立追加表，每条记录为 `{seq, kind, payload}`。
存储分配递增 seq，批量追加与 lastSeq 在同一事务提交；不逐 token 重写整个正文。
创建时预留 2048 bytes 的关闭空间，关闭时释放，确保写满后仍能记录有界中断原因。
附属数据计入 Resource 原有的单资源、Kind 和 Host 容量限制，超限整批回滚。

Host 的 StreamStore 提供 create、append、cite、complete、interrupt、read(afterSeq)、reader
和 subscribe/wait。reader 返回固定 UID、协议、状态与只读分页句柄，分页止于取得句柄时的 tail。
订阅是提示，持久化 seq 才是恢复位置；补偿读取也能发现另一 writer 的追加以及删除。
Stream 更新不通过资源 Watch 唤醒 Output Reconcile。

资源删除使后续写入失败，控制器完成删除后，数据库外键级联移除记录及容量账目。
容量回收将结构性 owner 与已释放的子资源作为整体：子资源不能单独提前淘汰，外部引用
仍保护整个被引用的归属树。生命周期策略保持在 ResourceDefinition。

## Agent 邮件协议

`aide.agent/v1` 沿用 Harness 事件：`agent_message`、`agent_message_chunk`、`agent_thought`、
`agent_thought_chunk`、`tool_call_update`、`tool_call_content_chunk`。按顺序回放：

- chunk 向对应 messageId 或 toolCallId 追加内容；不同消息分别保留。
- message upsert 的 content 缺省保留，null 或空数组清空，数组整体替换。完整快照不会重复累计增量。
- tool update 按字段更新，缺省保留、null 清空；工具状态与输入输出保留在协议中。

通道 renderer 和 Web 查询解释该协议。Output 的投递状态机只传递读取句柄，
不拼接 think/text 或解析工具内容。内容投影按 UID 缓存并从游标增量回放，缓存有数量上限。

例如正在生成的原始 Stream：

```yaml
apiVersion: aide.dev/v1alpha1
kind: Stream
metadata:
  name: reply-raw
  namespace: v1
  uid: stream:reply
  owner:
    apiVersion: aide.dev/v1alpha5
    kind: Output
    namespace: v1
    name: reply
    uid: output:reply
spec:
  protocol: aide.agent/v1
status:
  phase: open
  lastSeq: 1
  references:
    - apiVersion: aide.dev/v1alpha4
      kind: Note
      uid: note:evidence
      version: read-version
      contentVersion: body-fingerprint
```

正文不嵌入 CRD，按 UID 读出的记录例如：

```json
[{"seq":1,"kind":"agent_message_chunk","payload":{"messageId":"reply","content":{"type":"text","text":"已经找到"}}}]
```

Personal 的用法见 [Output](../personal/output.md)。原始和替换 Stream 都由同一个 Output 拥有。
不提供旧字段或历史记录兼容。


Host 的 `StreamStore.reader(ref, snapshot)` 可以重新打开已提交的状态快照，读取范围固定到快照的 lastSeq，保留当时的生成状态和引用。Personal 投递器持久化这一快照用于失败重试；后续追加或关闭不会改变重试内容。该能力只提供读取边界，不改变 Stream 的生成和关闭生命周期。
