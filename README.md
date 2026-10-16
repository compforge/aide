# Aide

Aide 是运行在自己服务器上的个人 Agent。它接下临时交办，把持续关注和定期处理保存为长期安排，再由时间或事件推动执行；需要补充信息时向用户提问，收到回答后继续。

当前提供可运行的单用户原型：网页 Channel、Task / Routine、Plugin Controller runtime、Codex Harness 和 Resource 文件持久化。飞书适配器还未接入。网页和后续 Channel 共用同一条请求与执行链路。

## 启动

使用 Node.js 22+ 安装依赖；服务运行于随依赖安装的 Bun 1.4.2。还需要已安装、完成登录的 Codex CLI。执行环境中的 CLI（如 larkcli、bytedcli）及其登录态直接供 Codex 使用。

```sh
npm ci
npm start
```

打开 <http://127.0.0.1:7433> 即可交办事情、回答问题和查看事项与安排。默认会话为 `me`；使用 `/?conversation=另一会话名` 可以分别试验不同场景。刷新页面会恢复已有对话。模型回复按纯文本展示。

默认监听 `127.0.0.1:7433`，Session、Plugin 配置和 Resource 保存到 `~/.aide/projects/`。同一个数据目录只允许一个 Aide 进程。部署到自己的服务器后，保持该进程运行即可继续处理安排；HTTP 接口是本机可信入口，没有认证，不直接暴露公网。

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

例如：`AIDE_CWD=/path/to/work AIDE_TIMEZONE=Asia/Shanghai npm start`。AI 执行统一由 Harness 提供，权限沿用 Codex 配置、执行环境和 CLI。请求识别的提示词禁止执行工作或调用工具。

## 交办与查看结果

```sh
curl -s http://127.0.0.1:7433/messages \
  -H 'content-type: application/json' \
  -d '{"id":"msg-1","conversationId":"me","text":"查看当前目录的 README，告诉我这个项目如何启动"}'

curl -s 'http://127.0.0.1:7433/work?conversationId=me'
curl -s 'http://127.0.0.1:7433/messages?conversationId=me'
```

POST 返回识别后的回复，执行在后台继续。GET `/messages` 读取持久化的 Aide 消息，包括异步结果和问题；加 `after=<message-id>` 可增量读取，`role=all` 可读取包括用户输入的完整对话。Channel 适配器应保存游标，负责把这些消息送给用户。用户回答仍提交到 `/messages`，使用相同 `conversationId` 和新的消息 `id`。

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

工作保存在 `Work` Resource 中，`spec.kind` 区分 Task 与 Routine。Plugin Manager 统一管理 Controller、Source、Watch、队列、cron、动态唤醒和重试；每个 Resource 的 status、回复和投递去重记录一起原子落盘，网页读取这些记录的投影。运行机制与扩展入口见 [runtime 设计](docs/runtime.md)。

Controller 默认总执行容量为 1；等待 Harness verb 时释放执行位，同一个 Resource 始终串行。暂停阻止后续推进，不能撤销已执行的 CLI 操作。关机错过的时间触发恢复后合并执行一次；运行中崩溃或调用失败会标为 `uncertain`，由用户核对结果后明确要求继续。基础设施 Reconcile 重试不会自动重放结果不明的业务执行。

personal Plugin 在独立 Worker 中通过 `context.verbs.harness` 请求执行。执行内核通过 Session、Lane、HarnessInvocation 和 Turn 管理执行，Codex 使用 `app-server` 协议；Aide 注入当前工作和最近 20 条工作历史。请求识别超时为 1 分钟，单次执行为 15 分钟。尚未提供通用长期记忆、完整上下文压缩、飞书等消息推送适配器或多实例部署。

## Linux 常驻部署

在服务器上的 checkout 安装依赖，确认 `node --version` 为 22+、`codex` 已登录，再运行：

```sh
npm ci
bash scripts/install-service.sh
loginctl enable-linger "$(id -un)"
```

安装脚本生成用户级 `aide.service`，固定当前 checkout 与 Bun 路径。Linger 让用户服务在 SSH 退出后仍然运行；如果机器禁止普通用户开启，可由管理员执行该命令。服务自动重启，日志进入 journal。

在 `~/.config/aide/env` 配置 `AIDE_CWD`、`AIDE_TIMEZONE` 等变量，然后 `systemctl --user restart aide`。建议把工作目录设为一个专门的目录，分别管理工作资料和服务源码。凭证沿用该 Linux 用户的 Codex / CLI 登录态。

systemd 不会读取登录 shell 的环境变量。如果模型或 CLI 需要代理，也要在该文件中配置 `HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY`（按客户端需要同时设置小写变量）。命令行可用而服务调用超时时，先检查这项差异。

```sh
systemctl --user status aide
journalctl --user -u aide -f
curl -s http://127.0.0.1:7433/health
```

`/health` 只报告 HTTP 服务存活及部署版本，不代表模型或业务 CLI 连通。通过真实任务验证模型和 CLI。服务更新后重新运行安装脚本；通过文件同步部署时可用 `AIDE_REVISION=<commit>` 标识源码版本。

在自己的电脑建立转发后打开 <http://127.0.0.1:7433>：

```sh
ssh -N -L 7433:127.0.0.1:7433 user@your-server
```

关闭转发只会断开浏览器连接，服务器仍会执行安排。停止服务使用 `systemctl --user stop aide`。

## 开发

```sh
npm run check
```

测试覆盖问答恢复、Task / Routine 转换、触发去重、调度恢复、并发输入与状态更新、HTTP 到 Harness 的流程，以及 Resource 乐观锁、级联删除、Source / Watch、Controller 重试、Plugin 激活回滚和共享容量。测试运行真实 Plugin Worker，使用模拟 Harness Adapter，不需要登录，也不代表真实飞书或业务 CLI 已验证。
