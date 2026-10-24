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
| `LOG_LEVEL` | 结构化日志级别，默认 `info` |

例如：`AIDE_CWD=/path/to/work AIDE_TIMEZONE=Asia/Shanghai npm start`。AI 能力由 Harness 提供，工具使用执行环境中已有的配置和凭证。Chief 可以直接查信息、回答问题，也可以按需操作 Work。

## 状态目录

AIDE_HOME 是应用状态根目录，默认 ~/.aide。当前主要数据按所有者保存：

| 位置 | 内容与恢复责任 |
| --- | --- |
| resources.sqlite 及 WAL | 业务 Resource、索引、引用与去重回执，由 Host 管理 |
| plugins/<pluginId>/ | 插件 package global 私有文件；其 instances/<instanceId>/ 为实例私有文件 |
| plugins/instances/ | Host 的插件实例元数据 |
| channels/ | Channel 收发与平台投递记录 |
| connectors/calls.jsonl | 外部调用意图与结果，未完成调用不自动重放 |
| harnesses/ | 按 Harness 显式同步的能力包缓存 |
| runtime.log | 插件与调度诊断 |
| harness-runtime.log、harness-native.jsonl | 有界执行及协议诊断，不参与会话恢复 |

Harness 自己保存原生历史；Pi 及基于 Pi 的领域 Agent 默认使用 ~/.pi/agent/sessions/。Personal 在资源 status.agent 保存 harness / sessionId，恢复时经 Harness 重新打开原生会话。配置原生目录的方式见 [Pi](harness/pi.md) 与 [Chief 记忆](personal/chief.md#存储与配置)。

备份时先停止服务，再保存应用状态、配置和所需原生会话；也可用 SQLite 在线备份获取数据库一致快照。只备份资源数据库能保留业务状态，但不足以恢复 Harness 原生上下文。凭证由运行用户和相应 CLI 管理，按各自方式备份。

AIDE_CWD 选择执行目录，不移动或清空业务数据。原生会话恢复会核对目录与 scope，改变工作目录后应确认已有会话是否仍可恢复。需要清空数据时显式停服、备份并重建。

## Linux 常驻部署

在服务器上的 checkout 安装依赖，确认 `node --version` 为 22.19+、Pi / Chief 模型和认证已配置，再运行：

```sh
npm ci
bash scripts/install-service.sh
loginctl enable-linger "$(id -un)"
```

安装脚本生成用户级 `aide.service`，固定当前 checkout 与 Bun 路径。Linger 让用户服务在 SSH 退出后仍然运行；如果机器禁止普通用户开启，可由管理员执行该命令。服务自动重启，日志进入 journal。

在 `~/.config/aide/env` 配置 `AIDE_CWD`、`AIDE_TIMEZONE` 等变量，然后 `systemctl --user restart aide`。建议把工作目录设为一个专门的目录，分别管理工作资料和服务源码。凭证沿用该 Linux 用户的 Pi / 业务 CLI 登录态。

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

HTTP 与 Personal 装配日志进入标准输出；应用根目录的 `runtime.log` 保存插件和调度日志，Runner 激活日志记录 pid。应用根目录的 `harness-runtime.log` / `harness-native.jsonl` 保存有界执行诊断与原生协议诊断，不参与恢复；原生会话引用位于资源的 `status.agent`，历史由 Harness 自己保存；Connector 调用事实位于 `connectors/calls.jsonl`。未使用 Harness 的新实例不会启动执行后端。检查问题时先记录版本、revision、topicId、Work id 与 invocationId，再核对外部操作是否已经发生。

Pi 和 Chief 可分别在 Aide 配置中声明模型并引用凭证环境变量，也可继承 Pi 原生配置。连接器设置见 [Connector 与 Source](connector/README.md)，Lark 机器人设置见 [Lark](channel/lark.md)。通过 `/health` 不能证明这些依赖可用。
