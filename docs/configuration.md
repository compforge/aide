# Aide 配置

Host 在启动时加载一份配置快照，验证后按职责装配 Connector、Harness 和 Plugin。
`config.yaml` 是 Aide 声明的事实来源；修改配置后重启服务，不做逐轮重读或隐式合并多份文件。

## 来源与优先级

配置文件的选择顺序是：调用方显式路径 > `AIDE_CONFIG` > `$AIDE_HOME/config.yaml`。
`AIDE_HOME` 缺省为 `~/.aide`。文件可写 YAML 或 JSON；显式文件缺失时报错，默认文件缺失时使用默认配置。

字段遵循 **显式配置值 > 默认值**。默认只补缺省字段；空数组表示明确关闭或清空该列表，
不因值为空而恢复默认。`null`、错误类型或不支持的字段报错，不通过默认值掩盖错误。
数组整体取配置值，不与另一份文件中的数组拼接。错误指出字段路径和错误类别，不回显配置值。

顶层配置只有三个命名空间：

| 配置 | 所有者与用途 |
|---|---|
| `connectors` | Host 装配全局环境目录、需求与 Forge 访问能力 |
| `harnesses` | Host 装配 Agent 的模型选择和扩展能力；当前支持 `chief` |
| `plugins` | 各 Plugin 校验和使用自己的业务配置；例如 Personal watches |

没有声明的 Connector/watch/package 列表默认为空。Connector 和 Plugin 的具体字段由所属实现校验，
不放宽顶层或 Chief 的字段检查。配置不是 Plugin 之间传递凭证的通道。

```yaml
connectors:
  environments:
    dev:
      kind: kubernetes
      kubeconfig: ~/.kube/dev
      namespace: example

harnesses:
  chief:
    model:
      provider: your-provider
      id: your-model
    packages:
      - git:github.com/your-org/agent-skills@v1

plugins:
  personal:
    watches: []
```

## Chief 默认值与外部配置

`harnesses.chief.model` 显式指定 provider/id 时优先于 Pi 的默认模型；模型必须已由 Pi 配置，
不存在时直接报错。省略该字段时沿用 Pi 的模型选择。认证及模型提供方定义继续由 Pi 的
`auth.json` / `models.json` 管理，默认位于 `~/.pi/agent`，不复制凭证到 Aide 配置。

`harnesses.chief.packages` 默认为 `[]`，Chief 只加载其中包所声明的 skills。
不会继承 Pi 的 packages、`~/.agents/skills` 或项目自动发现的 skills。普通 `pi` Harness 保持其原生发现行为。
包来源使用 Pi 的 Git/npm/本地目录格式；本地路径写成绝对路径、`~/...` 或 `./...` / `../...`，
后两者相对所选配置文件目录解析，不随服务工作目录改变。

`AIDE_MODEL` 目前只控制默认 Codex Target，不参与 Chief 的模型优先级。
服务端口、工作目录、时区、飞书和代理仍使用[部署文档](deployment.md)中的环境变量；
它们与当前 YAML 字段没有重叠覆盖关系。

## 能力包同步

修改 packages 后，先停止服务，在相同的运行用户和 `AIDE_HOME` / `AIDE_CONFIG` 下执行：

```bash
aide harness sync chief
```

源码 checkout 可使用 `node bin/aide.js harness sync chief`。该命令调用 Pi 原生 package manager，
缓存放在 `$AIDE_HOME/harnesses/chief/`，不写 Pi 的个人 settings.json。未固定 ref 的 Git 包在显式同步时
更新；需要可复现的版本时固定 commit。同步与服务共用单实例锁，运行中不能更新正在读取的包。

启动只读取同步成功的包；缺包、声明改变、无 skills 或 skill 元数据无效时报错。
同步中断后须重新同步，不继续使用半更新状态。对话创建和模型调用不会触发安装或更新。
同步包不会安装 ascli 等业务 CLI；它们及凭证由运行环境独立提供。

环境配置见 [Connector](connector/README.md)，Chief 的角色、工具和会话行为见 [Chief](harness/chief.md)。
