# 需求平台：需求、评论与人物

Aide 持续观察指定负责人名下的工作项和讨论，把变化交给 Chief；Chief 可以忽略、直接答复，或交给 Task / Routine 跟进。答复使用独立 Output，Host 把它投递为指定工作项的评论。观察事实、理解人物和实际发送分别有自己的记录。

## 配置

服务用户需要能执行提供方 CLI，并已完成该 CLI 的登录。Aide 复用 CLI profile，不保存 OAuth 凭证。每条 CLI 命令有 20 秒超时和 4 MiB 输出上限。

Connector 声明位于 `connectors.requirements.<name>`，包含以下字段：

| 字段 | 含义 |
|---|---|
| `provider` | 对应 Connector 实现的提供方标识 |
| `projectKey` | 目标项目标识 |
| `profile` | 提供方 CLI 的执行账号配置，可省略 |
| `categories` | 工作项类别，例如 `story`、`issue` |
| `assigneeField` | 负责人字段，缺省为 `current_status_operator` |
| `me.userKey` | 被服务的人的稳定用户键，可省略 |

配置好名为 `work` 的 Connector 后，Personal 的观察策略如下：

```yaml
plugins:
  personal:
    sources:
      requirements:
        - id: my-requirements
          source: work
          userKeys: [your-human-user-key]
          intervalMs: 300000
```

三个配置表达不同的含义：

- `profile` 选择执行读写的 CLI 账号，可以是受托账号。
- `me.userKey` 标记被服务的人。启动时解析规范 host / project key，以规范作用域和稳定 user key 识别本人，并与其他已配置 Me 身份归入同一个 Person；Source 仍只使用该 Connector 的 Me 配置判断关系。
- `userKeys` 选择观察哪些负责人的工作；可以包含他人，不会把这些人标记成 Me。

`me` 可省略。没有匹配的 Me 身份时，Input.relation 保持未知。Person 身份使用提供方标识、规范 host/project scope 和 user key；显示名不参与身份匹配，也不凭同名把不同平台的人物合并。Connector 读取会贡献人物身份和姓名，Chief 通过 `summary_person` 积累认识。

## 观察与恢复

需求列表按配置类别、负责人字段及更新时间窗口分页。一次扫描固定结束时间，沿提供方 session/cursor 读完所有页才推进水位；第一页不使用会截断结果的 MQL LIMIT。随后扫描保留一分钟重叠窗口。已跟踪工作项独立读取详情，因此完成、关闭、转交给别人不会仅因从负责人列表消失而漏掉最后一次变化。

首次发现尚未结束的工作项会生成 Input，并以发现时间建立评论基线。后续标题、状态、负责人和描述变化会生成新的事实输入。评论单独按固定时间窗口分页，不依赖工作项的 updated_at；首次发现前的历史评论可按需读取，但不会批量送入 Chief。完成或转交的工作项读完当前评论窗口后退出跟踪。

Source 在发送 Input 前持久化页数据和输入计划，Input 写入成功后才更新对应检查点。单调观察序号让 A→B→A→B 中的两次 A→B 都得到保留；中断重试复用已冻结的 Input 身份和正文。读取失败保留检查点并记录错误。长评论的 Input.text 是有界预览，完整评论保留在 observation 中。

评论有明确作者时设置可选 sender：作者是 Me 为 `sent`，结构化收件人中有 Me 为 `received`，Me 属于该观察范围为 `observed`。只接受提供方返回的稳定用户键，不把 Markdown 提及中的 Lark ID 当成需求平台的 user key。系统状态变化没有猜测的 sender。relation 表达信息与我的关系，不授予执行或发信权限。

这是一种周期观察：无法还原两次采样间已消失的状态，也不保证捕获窗口外对旧评论的编辑。工作项权限消失时保留错误，不推断为完成。没有接入 webhook。

## 回复与投递

Input.source 携带 `RequirementAddress`：

```ts
{ kind: "requirement", source: "work", category: "story", id: "123", scope: "https://requirements.example.com/canonical-project-key" }
```

Chief 通过 `say({respondToInputId, text})` 回复该工作项，或显式指定已知 target。Source 会话没有自动默认地址。Output.receivers 记录话说给谁，不会隐式添加 @ 或通知名单。读取评论可用 `read_requirement_comments`，并沿 nextCursor 获取下一页。

Host 投递器先核对保存地址的项目 scope，再标记 sending 并调用 Connector 的评论写入能力。成功回执记录外部 comment ID；配置换到其它项目后，旧 Output 不会被转投。Runner 的 Connector API 只开放读取，实际发送经过 Output。

评论写入没有已确认的提供方幂等键。因此进入发送后遇到超时或进程中断，Output 保持 uncertain，自动重发停止。内容中附带相关标记；后续评论回读只有同时匹配持久投递记录、目标和正文，才恢复 delivered 并排除自己的回声。已拿到的 comment ID 也可直接与正文核对。同账号下人工发出的其它评论仍是正常输入。标记不是远端幂等承诺；提供方若移除标记且未拿到回执，需要人工核对。

投递与评论回执复用 Host 的去重存储，在其配置的去重窗口内独立于 Output 正文回收。投递失败不会让 Chief 重做业务动作。完整语义见 [Output](../personal/output.md)。

## 验证

`npm run check` 覆盖 Connector 分页和映射、跨 Runner 的读取、Me 与执行账号区分、Source 检查点及重启、完成/转交、评论独立水位、长文本、Output 回执与回声过滤、发送不确定时停止重试。外部服务和模型使用替身。

真实接入还需用目标项目确认实际字段、权限和评论响应；CLI 命令结构验证不等同于端到端验收。真实评论发送需要明确的工作项和内容，不由自动测试触发。
