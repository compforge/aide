# Aide

Aide 是运行在自己服务器上的个人 Agent。它接下临时交办，把持续关注和定期处理保存为长期安排，再由时间或事件推动执行；需要补充信息时向用户提问，收到回答后继续。

当前提供可运行的单用户原型：HTTP Channel、Task / Routine、Codex Harness 和文件持久化。飞书适配器还未接入。HTTP 入口可以用于本地试用，也作为后续 Channel 的接入点。

## 启动

需要 Node.js 22+，以及已安装、完成登录的 Codex CLI。执行环境中的 CLI（如 larkcli、bytedcli）及其登录态直接供 Codex 使用。

```sh
npm ci
npm start
```

默认监听 `127.0.0.1:7433`，数据保存到 `~/.aide/state.json`。同一个数据目录只允许一个 Aide 进程。部署到自己的服务器后，保持该进程运行即可继续处理安排；HTTP 接口是本机可信入口，没有认证，不直接暴露公网。

可用环境变量：

| 变量 | 用途 |
| --- | --- |
| `AIDE_HOME` | 状态文件目录，默认 `~/.aide` |
| `AIDE_CWD` | CLI 执行工作目录，默认启动目录 |
| `AIDE_PORT` | 本地端口，默认 `7433` |
| `AIDE_TIMEZONE` | 默认时区，默认服务器时区；可设 `Asia/Shanghai` |
| `AIDE_MODEL` | Codex 模型，默认沿用 Codex 配置 |
| `AIDE_SANDBOX` | 执行时的 Codex sandbox，未设时沿用 Codex 默认配置；可选 `read-only`、`workspace-write`、`danger-full-access` |
| `LOG_LEVEL` | 结构化日志级别，默认 `info` |

例如：`AIDE_CWD=/path/to/work AIDE_TIMEZONE=Asia/Shanghai npm start`。请求识别使用只读 sandbox，实际工作的权限由 Codex 配置、执行环境和 CLI 决定。

## 交办与查看结果

```sh
curl -s http://127.0.0.1:7433/messages \
  -H 'content-type: application/json' \
  -d '{"id":"msg-1","conversationId":"me","text":"查看当前目录的 README，告诉我这个项目如何启动"}'

curl -s 'http://127.0.0.1:7433/work?conversationId=me'
curl -s 'http://127.0.0.1:7433/messages?conversationId=me'
```

POST 返回识别后的回复，执行在后台继续。GET `/messages` 读取持久化的 Aide 消息，包括异步结果和问题；加 `after=<message-id>` 可增量读取。Channel 适配器应保存游标，负责把这些消息送给用户。用户回答仍提交到 `/messages`，使用相同 `conversationId` 和新的消息 `id`。

入站消息的 `id` 在会话内用于投递去重；重试同一消息应沿用原 id。不同会话的工作分别匹配，但它们仍属于同一个人的 Aide。

持续安排同样用自然语言交办：

```sh
curl -s http://127.0.0.1:7433/messages \
  -H 'content-type: application/json' \
  -d '{"id":"msg-2","conversationId":"me","text":"每天北京时间 9 点检查当前项目的待办，仅在有新阻塞时告诉我"}'

curl -s http://127.0.0.1:7433/messages \
  -H 'content-type: application/json' \
  -d '{"id":"msg-3","conversationId":"me","text":"每当收到 docs.changed 事件时，检查变化是否影响我的待办，有重要变化再通知我"}'

curl -s http://127.0.0.1:7433/events \
  -H 'content-type: application/json' \
  -d '{"id":"event-1","conversationId":"me","name":"docs.changed","text":"项目 A 的需求文档有更新"}'
```

## 工作方式与边界

Task 表示有限目标，Routine 表示持续职责。请求可以创建工作、补充已有工作、回答问题、暂停或继续，也可以更新类型完成 Task / Routine 转换，保留 id 和历史。匹配和意图识别由模型完成，不能保证每次判断正确；信息不足时应询问用户。

Reconcile 调用 Harness 推进工作。执行结果分为完成、询问用户和等待指定时间。Routine 的“完成”只结束本次执行，之后继续等待下一次触发。问答存入状态，不依赖一个长期挂起的调用栈。

主动发现通过带有明确关注目标的 Routine 表达：定时或事件唤醒、读取 CLI 信息、对照历史、通知有价值的变化。当前可建议创建后续 Task / Routine，用户再通过消息交办；尚未实现自动派生工作。

这个原型采用单进程串行执行和原子 JSON 快照。暂停阻止后续推进，不能撤销已执行的 CLI 操作。关机错过的时间触发恢复后合并执行一次；运行中崩溃或调用失败会标为 `uncertain`，由用户核对结果后明确要求继续，避免自动重放外部操作。

每次 Codex 调用独立运行，Aide 注入当前工作和最近 20 条工作历史。请求识别超时为 1 分钟，单次执行为 15 分钟。尚未提供通用长期记忆、完整上下文压缩、消息主动推送适配器或多实例部署。

## 开发

```sh
npm run check
```

测试覆盖问答恢复、Task / Routine 转换、触发去重、调度恢复、并发输入与状态更新，以及 HTTP 到 Harness 的流程。测试使用模拟模型和 Codex 子进程，不需要登录，也不代表真实飞书或业务 CLI 已验证。
