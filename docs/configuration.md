# Aide 配置

Host 在启动时加载一份配置快照，验证后按职责装配 Connector、Harness 和 Plugin。
`config.yaml` 是 Aide 声明的事实来源。启动时完成模块校验后才恢复 Session 和启动 Channel；修改配置后重启服务。
新建、恢复和重建 Harness 都复用启动配置，运行期间修改 Aide 或 Pi 的 models/settings 文件不会改变它。

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

Chief 模型的优先级是 **Aide 显式字段 > 同一模型的 Pi 定义 > SDK 默认值**。
模型配置由 `src/host/harness/chief/config.ts` 和 `pi/config.ts` 在启动阶段解析；Agent 只接收有效配置。

- 已注册的模型可以只声明 `provider/id`；省略整个 `model` 时使用 Pi settings 的 `defaultProvider/defaultModel`，两者都未设置时使用 SDK 可用模型列表的首项。
- 新 ID 可以直接在 Aide 定义；连接信息可继承同一 provider。provider 有多种 API 且无法唯一确定时，必须显式指定 `api`。
- 新 ID 不继承另一个模型的推理能力和容量。缺省遵循锁定 Pi SDK 的自定义模型默认值：`reasoning: false`、`input: [text]`、`contextWindow: 128000`、`maxTokens: 16384`；应按部署模型的实际能力配置。
- 显式 `false` 和支持的空列表不会回退；无效字段、未知 API、缺少连接信息或认证来源会阻止启动。
- 恢复原生会话时，启动模型选择优先于历史记录中的模型；对话历史继续保留。

```yaml
harnesses:
  chief:
    model:
      provider: custom
      id: your-deployment
      api: openai-completions
      baseUrl: https://model.example.com/v1
      apiKeyEnv: MODEL_API_KEY
      # 以下能力按实际模型填写，此处仅为示例。
      reasoning: false
      input: [text]
      contextWindow: 32768
      maxTokens: 4096
    packages: []
```

`name` 可选。`api` 使用 Pi 已注册的 API 类型；`contextWindow` 和 `maxTokens` 必须为正整数。
`apiKeyEnv` 指定启动环境中的变量名，变量缺失或为空时报错；其值优先于继承的 Pi 凭证，仅在本进程内使用。
未声明时复用 Pi 认证。Aide 不改写 `~/.pi/agent/models.json` 或 `auth.json`，认证 token 刷新仍由 SDK 管理。
Chief 和普通 Pi 各自解析配置，Chief 的覆盖不修改普通 Pi 的模型与 skills。

启动日志记录所选 provider/model、配置来源和 skills 数量，不输出密钥。校验确认配置可解析及认证已配置，
不代表模型远端一定可用；部署验收仍需完成一次真实模型请求。

`harnesses.chief.packages` 默认为 `[]`，Chief 只加载其中包所声明的 skills。
不会继承 Pi 的 packages、`~/.agents/skills` 或项目自动发现的 skills。普通 `pi` Harness 保持其原生发现行为。
包来源使用 Pi 的 Git/npm/本地目录格式；本地路径写成绝对路径、`~/...` 或 `./...` / `../...`，
后两者相对所选配置文件目录解析，不随服务工作目录改变。

`AIDE_MODEL` 目前只控制默认 Codex Target，不参与 Chief 的模型优先级。
Codex 启动命令、sandbox 和模型选择从启动环境确定。外部 CLI 的原生配置由其自身接口管理；
Aide 的快照不等于冻结了外部 CLI 的所有文件和登录态。
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

## 模块归属

顶层 `src/config.ts` 加载文件并组合各模块 schema。Harness 配置位于 `src/host/harness/<name>/config.ts`，
Connector 配置由 `connectors/config.ts` 组合，Environment 和 Meego 分别声明自己的字段与校验。
配置输入允许缺省和引用；有效配置已补齐默认值、解析模型与路径，并在创建运行实例之前验证。
Personal 只绑定会话与业务工具，不参与模型配置来源或覆盖顺序的判断。整体原则见 [Kernel](kernel.md#配置所有权与生命周期)。
