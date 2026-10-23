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

Session 统一存放在 `$AIDE_HOME/sessions/<directory>/`，包含执行历史、日志和插件私有数据；持久 Input 与插件 Resource 统一位于 `$AIDE_HOME/resources.sqlite`。带命名空间的逻辑 ID 使用编码目录，原始 sessionId 见 meta.json。`AIDE_CWD` 只选择执行目录，改变它保留 Aide 数据并清空原生 Harness 绑定。服务启动时恢复所有已有 Session 和配置的 Source；新的 Channel 上下文按输入的 sessionId 创建 Session。

资源数据库使用 WAL。备份时停止服务并保存数据库及其 WAL 文件，或使用 SQLite 的在线备份能力。启动会一次性导入现有 `inputs.json` 与 Session 下的资源 JSON；原文件保留为静态备份，导入后读写以 SQLite 为准。回退旧版本前须单独制定数据恢复方案，不能将这些静态备份当作最新状态。

插件私有文件分为全局 `plugins/<pluginId>/`、Session 内的 `sessions/<id>/plugins/<pluginId>/` 和其下的实例目录，不提供 project 级目录。

Harness 原生会话沿用各自默认目录；Pi / Chief 通常位于 `~/.pi/agent/sessions/`。Aide Session 只保存恢复绑定与统一执行事实。已保存的 Pi 原生文件仍通过恢复句柄打开，不按新目录重新猜测身份。

开发阶段不自动迁移或读取旧的 `projects/` 布局，也不删除其中数据。升级后若只有旧布局，服务将从空 Session 开始。

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

HTTP 与 Personal 装配日志进入标准输出；应用根目录的 `runtime.log` 保存插件和调度日志，Runner 激活日志记录 pid。应用根目录的 `harness-runtime.log` / `harness-native.jsonl` 保存有界执行诊断与原生协议诊断，不参与恢复；原生会话引用位于资源的 `status.agent`，历史由 Harness 自己保存；Connector 调用事实位于 `connectors/calls.jsonl`。未使用 Harness 的新实例不会启动执行后端。检查问题时先记录版本、revision、conversationId、Work id 与 invocationId，再核对外部操作是否已经发生。

Pi 和 Chief 可分别在 Aide 配置中声明模型并引用凭证环境变量，也可继承 Pi 原生配置。连接器设置见 [Connector 与 Source](connector/README.md)，Lark 机器人设置见 [Lark](channel/lark.md)。通过 `/health` 不能证明这些依赖可用。
