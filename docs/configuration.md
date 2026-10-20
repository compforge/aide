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

顶层 `defaultHarness` 是 Aide 的执行选择，模块配置分别位于以下三个命名空间：

| 配置 | 所有者与用途 |
|---|---|
| `connectors` | Host 装配全局环境目录、需求、Forge 与 Lark 消息读取能力 |
| `harnesses` | Host 装配 Agent 的模型选择和扩展能力；支持 `pi`、`chief`、`codex`、`claude`、`dsh` |
| `plugins` | 各 Plugin 校验和使用自己的业务配置；持续观察策略位于 `plugins.<plugin>.sources` |

没有声明的 Connector/Source/package 默认为空。Connector 和 Plugin 的具体字段由所属实现校验，
不放宽顶层或 Harness 的字段检查。配置不是 Plugin 之间传递凭证的通道。

Connector 配置访问能力，声明它不会启动持续观察。Personal 的策略统一位于 `plugins.personal.sources`：

- `environments` 显式选择环境与 namespace；`targets: []` 关闭环境观察。
- `lark: {}` 启用默认观察策略，不按消息类型限制输入；Source 产出的消息均进入处理流程，当前采集能力覆盖单聊和群内 @。字段与权限见 [Lark 消息观察](connector/lark-messages.md)。
- `requirements` 配置需求观察列表，包含 Connector 引用、负责人范围与间隔；空数组关闭需求观察。

省略某类 Source 就关闭对应观察，Connector 仍可按需查询。Source 引用缺失的 Connector、环境不可用于本地 Kubernetes 采样，
或策略字段不受支持时，启动报错。Personal 在恢复 Session 前校验这些策略，启动日志汇总生效的观察范围和间隔。

```yaml
defaultHarness: pi

connectors:
  environments:
    dev:
      kind: kubernetes
      kubeconfig: ~/.kube/dev

harnesses:
  pi:
    model:
      provider: your-provider
      id: your-work-model
    packages:
      - git:github.com/your-org/agent-skills@v1
  chief:
    model:
      provider: your-provider
      id: your-model
    packages:
      - git:github.com/your-org/agent-skills@v1

plugins:
  personal:
    sources:
      environments:
        targets:
          - environment: dev
            namespaces: [example]
        intervalMs: 300000
      requirements: []
```

## 默认执行 Harness

根级 `defaultHarness` 缺省为 `pi`，可选 `pi`、`codex`、`claude`、`dsh`。这是 Aide 的装配选择，
`harnesses.<name>` 只声明对应实现的配置。Chief 始终负责接话与调度，其角色不受默认工作执行选择影响。
未知值、空值和 `chief` 均报错；代码不将无效选择静默降级为 Pi。

启动时准备 Chief 与选中的执行 Harness，生成固定的默认 Target。只有 Pi 被选中时才解析执行 Pi 的模型、技能与同步收据；
未选中的模块配置仍需满足字段结构。CLI 的登录态、原生配置与可用性由相应提供方负责，启动解析不代表远端连通。
修改选择后重启生效；已有 Aide 工作和历史保留，不同 Harness 的原生恢复绑定会清除，中断待核对的工作不会自动重试。

例如，使用 Codex 执行 Task / Routine：

```yaml
defaultHarness: codex
harnesses:
  codex:
    command: [codex, app-server]
    approvalReviewer: auto_review
    model: your-codex-model
```

| Harness 配置 | 字段 |
|---|---|
| `harnesses.pi` / `harnesses.chief` | `model` 对象、`packages` 列表，见下文 |
| `harnesses.codex` | `command` 非空参数数组、`approvalReviewer`（`user` / `auto_review`）、`model` 字符串 |
| `harnesses.claude` | `executable`、`model` 字符串；显式 executable 优先于启动环境的 `AIDE_CLAUDE_BIN` |
| `harnesses.dsh` | `dshBin`、`profile`、`dshHome`、`provider`、`model`、`reasoningEffort`、`patches`、`maxTokens` |

省略 CLI 的模型时沿用原生提供方配置；各模块保留已有命令默认值。

## Pi / Chief 默认值与外部配置

两种 Harness 分别按自己的 `model` 解析，模型的优先级是 **Aide 显式字段 > 同一模型的 Pi 定义 > SDK 默认值**。
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
Chief 和通用 Pi 各自解析配置；同一模型需分别声明或使用 YAML anchor 复用声明。模型 ID 属于运行配置，代码不提供固定业务模型默认值。

启动日志记录所选 provider/model、配置来源和 skills 数量，不输出密钥。校验确认配置可解析及认证已配置，
不代表模型远端一定可用；部署验收仍需完成一次真实模型请求。

`harnesses.pi.packages` 和 `harnesses.chief.packages` 均默认为 `[]`。内置装配只加载各自声明包中的 skills；
空列表明确关闭包技能，不继承用户或项目的自动发现。直接使用通用 Pi 工厂的调用方仍可自行决定是否启用原生发现。
包来源使用 Pi 的 Git/npm/本地目录格式；本地路径写成绝对路径、`~/...` 或 `./...` / `../...`，
后两者相对所选配置文件目录解析，不随服务工作目录改变。

当 `defaultHarness: pi` 时，Task / Routine 使用的模型和能力包由 `harnesses.pi` 决定。
外部 CLI Adapter 的原生配置由其自身接口管理。
服务端口、工作目录、时区、Lark 和代理仍使用[部署文档](deployment.md)中的环境变量；
它们与当前 YAML 字段没有重叠覆盖关系。

## 能力包同步

修改 packages 后，先停止服务，在相同的运行用户和 `AIDE_HOME` / `AIDE_CONFIG` 下执行：

```bash
aide harness sync pi
aide harness sync chief
```

源码 checkout 可使用 `node bin/aide.js harness sync pi` 或 `node bin/aide.js harness sync chief`。该命令调用 Pi 原生 package manager，
缓存分别放在 `$AIDE_HOME/harnesses/pi/` 与 `$AIDE_HOME/harnesses/chief/`，不写 Pi 的个人 settings.json。未固定 ref 的 Git 包在显式同步时
更新；需要可复现的版本时固定 commit。同步与服务共用单实例锁，运行中不能更新正在读取的包。

启动只读取同步成功的包；缺包、声明改变、无 skills 或 skill 元数据无效时报错。
同步中断后须重新同步，不继续使用半更新状态。对话创建和模型调用不会触发安装或更新。
同步包不会安装 ascli 等业务 CLI；它们及凭证由运行环境独立提供。

环境配置见 [Connector](connector/README.md)，Chief 的角色、工具和会话行为见 [Chief](harness/chief.md)。

## 模块归属

顶层 `src/config.ts` 加载文件并组合各模块 schema。Harness 配置位于 `src/host/harness/<name>/config.ts`，
Connector 配置由 `connectors/config.ts` 组合，Environment 和 Meego 分别声明自己的字段与校验。
Personal 的 `config.ts` 组合各类 Source 策略，装配阶段解析后仅向所属 Runner 下发有效观察范围。
配置输入允许缺省和引用；有效配置已补齐默认值、解析模型与路径，并在创建运行实例之前验证。
Personal 只绑定会话与业务工具，不参与模型配置来源或覆盖顺序的判断。整体原则见 [Kernel](kernel.md#配置所有权与生命周期)。
