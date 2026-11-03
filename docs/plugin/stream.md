# Stream

Stream 是带 Resource 身份、结构性 owner 和终态的追加内容。当前使用
`aide.dev/v1alpha1 Stream`。它不包含 Person、Address、禁言或投递权限。

`metadata.owner` 必须携带 owner UID；同名重建不继承内容。`spec` 为空。
`status` 保存 `phase: open | completed | interrupted`、`lastSeq`，终态还保存
`closedAt`，异常终止可保存 `error`。完成后不能追加或重新打开。

正文按 Stream UID 存在独立追加表，每条记录为 `{seq, kind: think | text, delta}`。
存储分配递增 seq，批量追加与 lastSeq 在同一事务提交；不会逐 token 重写整个正文。
创建时预留 2048 bytes 的关闭空间，关闭时释放，确保写满后仍可记录有界中断原因。
附属数据的大小计入 Resource 原有的单资源、Kind 和 Host 容量限制，超限整批回滚。

Host 的 StreamStore 提供 create、append、complete、interrupt、read(afterSeq)、snapshot
和 subscribe/wait。订阅是提示，持久化 seq 才是恢复位置；补偿读取也能发现另一 writer
实例的追加以及删除。Stream 更新不触发消费它的 Output Reconcile。

资源删除会使后续写入失败，控制器完成删除后，数据库外键级联移除追加记录及容量账目。
容量回收将结构性 owner 与已释放的子资源作为整体：子资源不能单独提前淘汰，外部引用
仍保护整个被引用的归属树。生命周期策略保持在 ResourceDefinition。

Personal 的用法见 [Output](../personal/output.md)。原始和替换 Stream 都由同一个
Output 拥有，Stream 不拥有 Output。


例如，一条正在生成的原始 Stream：

```yaml
apiVersion: aide.dev/v1alpha1
kind: Stream
metadata:
  name: reply-raw
  namespace: v1
  uid: stream:output:reply:raw
  owner:
    apiVersion: aide.dev/v1alpha5
    kind: Output
    namespace: v1
    name: reply
    uid: output:reply
spec: {}
status:
  phase: open
  lastSeq: 2
```

正文不嵌入 CRD，按 UID 读出的记录例如：

```json
[{"seq":1,"kind":"think","delta":"正在核对资料"},{"seq":2,"kind":"text","delta":"已经找到"}]
```
