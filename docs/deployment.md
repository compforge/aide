# 部署与诊断

Aide 以单个服务实例管理自己的状态目录。配置模型、CLI 和工作目录后，可在本机运行或部署到自己的 Linux 服务器。

## 配置

可用环境变量：

| 变量 | 用途 |
| --- | --- |
| `AIDE_HOME` | 状态文件目录，默认 `~/.aide` |
| `AIDE_CWD` | CLI 执行工作目录，默认启动目录 |
| `AIDE_PORT` | 本地端口，默认 `7433` |
| `AIDE_TIMEZONE` | 默认时区，默认服务器时区；可设 `Asia/Shanghai` |
| `AIDE_CONFIG` | 全局 Connector、Harness 与 Plugin 配置，默认 `$AIDE_HOME/config.yaml`；[字段与优先级](configuration.md) |
| `AIDE_MODEL` | Codex 模型，默认沿用 Codex 配置 |
| `AIDE_SANDBOX` | 执行时的 Codex sandbox，未设时沿用 Codex 默认配置；可选 `read-only`、`workspace-write`、`danger-full-access` |
| `LOG_LEVEL` | 结构化日志级别，默认 `info` |

例如：`AIDE_CWD=/path/to/work AIDE_TIMEZONE=Asia/Shanghai npm start`。AI 能力由 Harness 提供，工具使用执行环境中已有的配置和凭证。Chief 可以直接查信息、回答问题，也可以按需操作 Work。

## 状态目录

Session 统一存放在 `$AIDE_HOME/sessions/<id>/`，包含执行历史、日志、Conversation 和插件资源。`AIDE_CWD` 只选择执行目录，改变它不会另开一组 Session。服务启动时恢复最近的 Session；没有 Session 时创建一个。

插件私有文件分为全局 `plugins/<pluginId>/`、Session 内的 `sessions/<id>/plugins/<pluginId>/` 和其下的实例目录，不提供 project 级目录。

Harness 原生会话沿用各自默认目录；Pi / Chief 通常位于 `~/.pi/agent/sessions/`。Aide Session 只保存恢复绑定与统一执行事实。已保存的 Pi 原生文件仍通过恢复句柄打开，不按新目录重新猜测身份。

开发阶段不自动迁移或读取旧的 `projects/` 布局，也不删除其中数据。升级后若只有旧布局，服务将从空 Session 开始。

## Linux 常驻部署

在服务器上的 checkout 安装依赖，确认 `node --version` 为 22.19+、Pi 模型已配置且 `codex` 已登录，再运行：

```sh
npm ci
bash scripts/install-service.sh
loginctl enable-linger "$(id -un)"
```

安装脚本生成用户级 `aide.service`，固定当前 checkout 与 Bun 路径。Linger 让用户服务在 SSH 退出后仍然运行；如果机器禁止普通用户开启，可由管理员执行该命令。服务自动重启，日志进入 journal。

在 `~/.config/aide/env` 配置 `AIDE_CWD`、`AIDE_TIMEZONE` 等变量，然后 `systemctl --user restart aide`。建议把工作目录设为一个专门的目录，分别管理工作资料和服务源码。凭证沿用该 Linux 用户的 Pi / Codex / CLI 登录态。

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

## 执行诊断

HTTP 与 Personal 装配日志进入标准输出；Session 的 `session.log` 保存执行和插件日志，`session.jsonl` 保存执行事实。Runner 激活日志记录 pid，可与 Host 区分。检查问题时先记录版本、revision、conversationId、Work id 与对应 Turn，再核对外部操作是否已经发生。

模型凭证沿用 Pi / Codex 的配置，连接器设置见 [Connector 与 Source](connector/README.md)，飞书机器人设置见 [Feishu](channel/feishu.md)。通过 `/health` 不能证明这些依赖可用。
