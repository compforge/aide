# Aide

Aide 是运行在自己服务器上的个人 Agent。你可以随口提问、临时交办、定期安排，或让它关注外部工作变化。电脑关机、聊天窗口关闭后，服务器仍继续处理已接下的工作。

Chief 是负责接话与判断的入口 Agent：普通问题直接回答，需要跟进时才创建或关联工作，需要用户决定时发起提问。当前提供单用户原型，通过 Web 和 Feishu 两个 Channel 与用户沟通。

## 聊天、事项与安排

- **Conversation（会话）**组织消息和上下文。不同飞书单聊、网页会话和 Source 关注范围可以有各自的会话。
- **Task（事项）**负责一个有限目标，完成后结束，例如“实现这个需求并验证”。
- **Routine（安排）**负责持续职责，由时间或事件推动，例如“每天检查项目待办，有新阻塞时告诉我”。
- **Work** 是 Task 与 Routine 的统称。Chief 可以读取、创建、更新或删除 Work，也可以把输入关联到已有工作。

一次提问不必产生 Task。创建工作表示已接下目标，完成与结果通知会异步出现。改变 Task / Routine 类型时，Chief 创建新工作，再按意图暂停或删除原工作。

主动发现由 Source 获取关注范围内的外部变化，交给 Chief 判断是否通知、询问或跟进。当前可观察 Meego 中指定负责人名下的近期需求，查询 GitHub / GitLab 的 PR 状态与评论。配置与覆盖范围见 [Connector 与 Source](docs/connector/README.md)。

## 快速开始

需要 Node.js 22.19+ 安装依赖；服务使用依赖中的 Bun。先配置 Pi 的模型与登录态（默认 `~/.pi/agent`），并安装、登录 Codex CLI。执行环境中的 CLI 和凭证直接供 Agent 使用。

```sh
npm ci
AIDE_CWD=/path/to/work AIDE_TIMEZONE=Asia/Shanghai npm start
```

打开 <http://127.0.0.1:7433>，例如输入“读取当前项目的 README，告诉我如何启动”。Chief 可以直接读取并回答；需要持续推进时再交办 Task 或 Routine。

网页左侧选择会话，中间显示消息、流式回复和执行过程，右侧查看该会话的事项与安排。已结束的思考与工具过程可以展开，刷新后仍保留。默认会话为 `me`；`/?conversation=另一会话名` 可以进入指定会话。

配置 `AIDE_FEISHU_APP_ID` 和 `AIDE_FEISHU_APP_SECRET` 后，可通过飞书机器人单聊收发消息，无需公网回调地址。创建机器人与权限配置见 [Feishu Channel](docs/channel/feishu.md)。

查看版本：

```sh
npm exec -- aide version
```

## 运行边界

当前 Chief 使用 `chief` Harness，它基于 Pi 并带有 Work、问答和 Connector 工具；Task / Routine 默认使用 Codex 执行。另有独立的通用 `pi` Harness，提供文件与 CLI 能力，不预装 Personal 工具。

状态默认保存在 `~/.aide`，由一个 Aide 服务进程管理。当前面向单用户，本地 HTTP 入口没有认证，会话分组不提供账号或权限隔离。飞书支持单聊文字；原生 Harness 权限请求仍在网页处理。

模型判断可能出错。执行中断或结果无法校验时，Aide 保留记录并等待用户核对后明确继续；暂停或删除工作不能撤销已经发生的外部动作。目前未提供通用长期记忆、完整上下文压缩或多实例部署。

环境变量、Linux 常驻服务、代理与 SSH 转发见 [部署与诊断](docs/deployment.md)。

## 开发与深入阅读

```sh
npm run check
```

自动测试使用真实 Plugin Runner / Pi SDK 与模拟外部服务；不代表真实模型判断、飞书或业务 CLI 已验证。真实验收步骤见 [E2E](docs/e2e.md)。

- [整体机制](docs/kernel.md)：Host / Runner、内置对象与 Harness。
- [插件运行机制](docs/plugin/README.md)：Resource / Reconcile 与扩展边界，Personal 是一个内置插件。
- [Personal 业务模型](docs/plugin/personal.md)：Chief、Task / Routine、主动发现与问答。
- [Channel 总览](docs/channel/README.md)：Web 与 Feishu 如何组织输入、会话和回复。
- [Harness](docs/harness/README.md)：通用执行边界；[Pi](docs/harness/pi.md) 与 [Chief](docs/harness/chief.md)。
- 修改代码前阅读 [AGENTS.md](AGENTS.md)；插件接口见 [aide-plugin](packages/plugin/README.md)。
