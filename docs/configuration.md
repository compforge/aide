# Aide 配置

Host 在启动时加载一份配置快照，验证后按职责装配 Connector、Harness 和 Plugin。
`config.yaml` 是 Aide 声明的事实来源。启动时完成模块校验后才恢复业务资源 和启动 Channel；修改配置后重启服务。
新建、恢复和重建 Harness 都复用启动配置，运行期间修改 Aide 或 Pi 的 models/settings 文件不会改变它。

## 沟通渠道

```yaml
defaultChannel: lark-work
channels:
  lark-work:
    kind: lark
    label: 飞书 · 工作账号
    enabled: true
    appId: cli_yourAppId
    appSecret: your-app-secret
    me:                         # 可选，与应用凭证独立
      openId: ou_yourOpenId      # 必须属于上面的机器人应用
```

`defaultChannel` 引用启用的实例，或内置 `web`。应用 ID 在实例间唯一；停用当前默认实例前需选择其他默认渠道。主动联系 Me 使用所选 Channel 自己的 me 配置，并按该身份查找 Person；不从 Connector 配置或其他 Person 账号推导。不需要配置 chatId 或先发一条消息。

Web「接入」页编辑同一份配置，显示当前启动快照与已保存配置是否不同；保存后需重启。页面不返回 App Secret，编辑同一应用时留空保留，更换应用需重新填写。服务用版本校验拒绝过期编辑，原子替换 YAML 并保留无关字段及注释，文件权限为 600。实际连接和投递仍需检查运行日志及 Output 状态。

Lark Channel 不再读取 `AIDE_LARK_APP_ID` / `AIDE_LARK_APP_SECRET`。机器人配置属于 channels；`connectors.lark` 的应用与用户登录态继续用于观察消息，二者互不替代。详细语义见 [Channel](channel/README.md#默认沟通渠道)。

## 来源与优先级

配置文件的选择顺序是：调用方显式路径 > `AIDE_CONFIG` > `$AIDE_HOME/config.yaml`。
`AIDE_HOME` 缺省为 `~/.aide`。文件可写 YAML 或 JSON；显式文件缺失时报错，默认文件缺失时使用默认配置。

字段遵循 **显式配置值 > 默认值**。默认只补缺省字段；空数组表示明确关闭或清空该列表，
不因值为空而恢复默认。`null`、错误类型或不支持的字段报错，不通过默认值掩盖错误。
数组整体取配置值，不与另一份文件中的数组拼接。错误指出字段路径和错误类别，不回显配置值。

顶层 `defaultHarness` 是 Aide 的执行选择，模块配置分别位于以下命名空间：

| 配置 | 所有者与用途 |
|---|---|
| `defaultChannel` | 主动联系 Me 的默认 Channel 实例，缺省为内置 `web` |
| `channels` | 命名沟通实例、机器人凭证与可选 Me 身份 |
| `resources` | Host 的持久 Resource 容量、按 Group/Kind 的回收策略与去重窗口 |
| `connectors` | Host 装配全局环境目录、需求、Forge 与 Lark 消息读取能力 |
| `harnesses` | Host 装配 Agent 的模型选择和扩展能力；支持 `pi`、`chief`、`route`、`task`、`routine`、`codex`、`claude`、`dsh` |
| `plugins` | 各 Plugin 校验和使用自己的业务配置；持续观察策略位于 `plugins.<plugin>.sources` |

没有声明的 Connector/Source/package 默认为空。Connector 和 Plugin 的具体字段由所属实现校验，
不放宽顶层或 Harness 的字段检查。配置不是 Plugin 之间传递凭证的通道。

Connector 直接按 `connectors.<name>` 声明 kind、version 和 config；Host 通过 `AIDE_CONNECTOR_REGISTRATION` 独立加载实现注册入口。声明、注册和调用见 [Connector 扩展](connector/extensions.md)。

Connector 配置访问能力，声明它不会启动持续观察。Personal 的策略统一位于 `plugins.personal.sources`：

- `environments` 显式选择环境与 namespace；`targets: []` 关闭环境观察。
- `lark: {}` 启用默认观察策略，不按消息类型限制输入；Source 产出的消息均进入处理流程，当前采集能力覆盖单聊和群内 @。字段与权限见 [Lark 消息观察](connector/lark-messages.md)。
- `requirements` 配置需求观察列表，包含 Connector 引用、负责人范围与间隔；空数组关闭需求观察。
- `repositories` 配置 Forge 仓库清单的低频刷新与失败重试；`pullRequests` 指定作者，通过仓库清单引用或直接账号范围观察 PR/MR 合并。两种 Source 独立保存快照与恢复进度；空数组关闭相应观察。见 [Forge](connector/forge.md)。

`connectors.lark.config.me` 标记代表本人的外部身份，与 CLI 执行的 `appId/userId` 独立：

```yaml
connectors:
  lark:
    kind: messages
    version: v1
    config:
      appId: cli_execution
      userId: ou_operator
      me:
        - appId: cli_execution
          openId: ou_human
        - appId: cli_bot
          openId: ou_human_in_bot_app
plugins:
  personal:
    sources:
      lark: {}
```

Me 中的 appId 是 openId 的身份作用域，不指定 CLI 登录应用。多个标记声明同一个人；启动时据此归并已有 Person，将各平台账号保存为同一人物的多个身份。配置仍按接入独立生效。
只使用机器人 Channel 时在 channels.<名称>.me 配置本人身份，无需配置 CLI 账号；启用消息 Source 则必须成对配置 CLI appId/userId，connectors.lark.config.me 独立控制该 Connector 的本人识别。
当前 CLI 读取实现使用用户授权，Me 标记不会扩大其访问范围或把用户授权切换为机器人授权。
CLI 账号不必是本人；观察到执行账号的私信或 @ 不会自动归为本人收到。
修改 Me 配置后重启，既有 Input 保留原关系；人物资料和认知在 Web Persons 编辑后立即生效。

省略某类 Source 就关闭对应观察，Connector 仍可按需查询。Source 引用缺失的 Connector、环境不可用于本地 Kubernetes 采样，
或策略字段不受支持时，启动报错。Personal 在恢复业务资源 前校验这些策略，启动日志汇总生效的观察范围和间隔。

```yaml
defaultHarness: pi

connectors:
  environments:
    kind: environment
    version: v1
    config:
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
            namespaces: [ example ]
        intervalMs: 300000
      requirements: []
```

## Reconcile 调度

```yaml
reconcile:
  maxTotalConcurrency: 8
```

`maxTotalConcurrency` 是正整数，缺省为 8，限制每个 Runner 启动新 Reconcile 的全局并发；Controller 自己声明的局部阈值仍生效。配置在启动时加载，修改后重启生效。

等待 verb 会释放容量，返回后直接恢复执行，允许暂时超过阈值；达到或超过阈值时不启动新的 Reconcile。同资源仍串行，外部调用预算由 Connector、Harness 各自负责。调度契约见 [Kernel](kernel.md)。

## 默认执行 Harness

根级 `defaultHarness` 缺省为 `pi`，可选 `pi`、`codex`、`claude`、`dsh`。这是 Aide 的装配选择，
`harnesses.<name>` 只声明对应实现的配置。Personal 的 Chief、Task 和 Routine 使用专属 Agent，不受通用执行选择影响。
未知值、空值和领域 Agent（`chief`、`route`、`task`、`routine`）均报错；代码不将无效选择静默降级为 Pi。

启动时准备 Chief、Route、Task、Routine 与选中的执行 Harness，装配固定的 Harness 配置。只有 Pi 被选中时才解析执行 Pi 的模型、技能与同步收据；
未选中的模块配置仍需满足字段结构。CLI 的登录态、原生配置与可用性由相应提供方负责，启动解析不代表远端连通。
修改选择后重启生效，影响后续通用 Harness 请求；Personal 专属 Agent 的选择保持不变，中断待核对的工作不会自动重试。

例如，选择 Codex 作为通用执行后端：

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
| `harnesses.pi` / `harnesses.chief` / `harnesses.task` / `harnesses.routine` | `model` 对象、`packages` 列表，见下文 |
| `harnesses.route` | 可选 `model` 对象；省略时复用 Chief 的已解析模型，不加载 packages 或技能 |
| `harnesses.codex` | `command` 非空参数数组、`approvalReviewer`（`user` / `auto_review`）、`model` 字符串 |
| `harnesses.claude` | `executable`、`model` 字符串；显式 executable 优先于启动环境的 `AIDE_CLAUDE_BIN` |
| `harnesses.dsh` | `dshBin`、`profile`、`dshHome`、`provider`、`model`、`reasoningEffort`、`patches`、`maxTokens` |

省略 CLI 的模型时沿用原生提供方配置；各模块保留已有命令默认值。

## Pi / Chief / Task / Routine 默认值与外部配置

Pi 与 Chief 分别按自己的 `model` 解析；Task / Routine 未声明 model 时复用 Chief 的已解析模型，声明时独立解析。模型的优先级是 **Aide 显式字段 > 同一模型的 Pi 定义 > SDK 默认值**。
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

`harnesses.pi.packages`、`harnesses.chief.packages`、`harnesses.task.packages` 和 `harnesses.routine.packages` 均默认为 `[]`。内置装配只加载各自声明包中的 skills；
空列表明确关闭包技能，不继承用户或项目的自动发现。直接使用通用 Pi 工厂的调用方仍可自行决定是否启用原生发现。
包来源使用 Pi 的 Git/npm/本地目录格式；本地路径写成绝对路径、`~/...` 或 `./...` / `../...`，
后两者相对所选配置文件目录解析，不随服务工作目录改变。

Task / Routine 始终使用独立 Agent，模型和能力包分别由 `harnesses.task` / `harnesses.routine` 决定；packages 不继承 Chief。
外部 CLI Adapter 的原生配置由其自身接口管理。
服务端口、工作目录、时区、Lark 和代理仍使用[部署文档](deployment.md)中的环境变量；
它们与当前 YAML 字段没有重叠覆盖关系。

## 能力包同步

修改 packages 后，先停止服务，在相同的运行用户和 `AIDE_HOME` / `AIDE_CONFIG` 下执行：

```bash
aide harness sync pi
aide harness sync chief
aide harness sync task
aide harness sync routine
```

源码 checkout 可使用 `node bin/aide.js harness sync pi` 、`node bin/aide.js harness sync chief` 、`node bin/aide.js harness sync task` 或 `node bin/aide.js harness sync routine`。该命令调用 Pi 原生 package manager，
缓存按名称放在 `$AIDE_HOME/harnesses/<pi|chief|task|routine>/`，不写 Pi 的个人 settings.json。未固定 ref 的 Git 包在显式同步时
更新；需要可复现的版本时固定 commit。同步与服务共用单实例锁，运行中不能更新正在读取的包。

启动只读取同步成功的包；缺包、声明改变、无 skills 或 skill 元数据无效时报错。
同步中断后须重新同步，不继续使用半更新状态。对话创建和模型调用不会触发安装或更新。
同步包不会安装 ascli 等业务 CLI；它们及凭证由运行环境独立提供。

环境配置见 [Connector](connector/README.md)，Chief 的角色、工具和会话行为见 [Chief](personal/chief.md)。

## Task 静默策略

```yaml
plugins:
  personal:
    task:
      agentIdleMs: 300000       # 执行结束、无下一条可执行输入后，静默 5 分钟释放运行句柄
      idleRetentionMs: 86400000 # 释放后继续保留 Task 24 小时
```

两项均为毫秒整数，范围 1000–2147483647。新分派清除两阶段计时；待处理 Input、等待用户、未来唤醒和待核对状态阻止 Task 回收。释放句柄保留 sessionId，回收 Task 通过 deletionTimestamp 与 finalize 完成，详见 [Task Agent](personal/task.md)。

## Routine 静默策略

```yaml
harnesses:
  routine:
    packages: []              # model 缺省复用 Chief，包独立声明
plugins:
  personal:
    routine:
      agentIdleMs: 300000     # 执行结束、无下一条可执行输入后，静默 5 分钟释放句柄
```

agentIdleMs 范围为 1000–2147483647 毫秒。Routine 保留 sessionId 和职责资源，之后由 cron、事件或 Chief Input 唤醒；没有静默回收阶段，显式删除才 finalize。见 [Routine Agent](personal/routine.md)。

## 模块归属

顶层 `src/config.ts` 加载文件并组合各模块 schema。Harness 配置位于 `src/host/harness/<name>/config.ts`，
Connector 配置由 `connectors/config.ts` 组合，Environment 和需求平台分别声明自己的字段与校验。需求平台的 `me.userKey` 标记本人，`profile` 选择执行账号，Source 的 `userKeys` 选择观察负责人；三者独立，完整示例见 [需求平台](connector/requirements.md)。
Personal 的 `config.ts` 组合各类 Source 策略，装配阶段解析后仅向所属 Runner 下发有效观察范围。
配置输入允许缺省和引用；有效配置已补齐默认值、解析模型与路径，并在创建运行实例之前验证。
Personal 只绑定会话与业务工具，不参与模型配置来源或覆盖顺序的判断。整体原则见 [Kernel](kernel.md)。

## Chief 定时回顾

```yaml
harnesses:
  chief:
    config:
      trigger:
        intervalSeconds: 60   # 检查周期
        idleSeconds: 900      # Chief 连续空闲多久后回顾
```

两项均为正整数秒，可独立配置。Topic 只保存 `trigger.enabled` 开关。首次空闲从 Topic 创建时计算，后续从任意一轮 Chief 执行结束时计算；Deferred Input 到达不会重置计时。回顾生成已绑定 root Topic 的系统 Input（`origin: trigger`、`attention: normal`），经普通处理链路复用当前原生 session，并通过 `assess_input` 保存结果；检查 memory、Topic 认识、未决问题、Work 和待处理 Input，不要求已有新变化。系统 Input 不刷新 Topic 的业务活跃时间。检查期间正在运行的 Chief 不会收到额外 steer / followUp，也不会在结束后补跑错过的周期。

## Topic 消费策略

`plugins.personal.topic` 控制 Input 预览和近期处理摘要大小，独立于 Source 的采集频率：

```yaml
plugins:
  personal:
    topic:
      idleMs: 604800000       # 子树 7 天无新 Input，可在安全交接后回收
      contextChars: 48000
      summaryChars: 4000
```

- Channel 默认 immediate，Source 默认 normal；EnvironmentSource 明确使用 deferred，定时回顾使用 normal；紧迫性不代表授权或必须外发。
- 普通输入在当前调用结束后 followup，复用原生历史；immediate 通过 steer 进入当前调用。明确不支持或拒绝时留队等待 followup，不中断现有动作。
- root Topic 的 `trigger.enabled` 默认开启。Chief 连续空闲达到阈值后，检查会发起回顾，即使没有新 Input；运行中的 Chief 不因定时检查而追加执行，每轮结束后重新计算空闲时间。一次调用最多两天。
- `contextChars` 限制新 Input 的描述预览，全文通过 `read_input` 分页读取；原生历史和压缩由 SDK 管理。
- `summaryChars` 限制 Topic 累计认识的长度，模型需合并后替换；近期处理记录使用 recent，统一限制条数和总字符数。长期认识使用共享记忆，委托进展保存在 Work。
- `assess_input` 提交业务消费回执并原子建立 Work 办理记录。没有回执的已尝试输入保留失败证据，不自动重放。


## Resource 容量

所有持久 Resource 共用 Host 存储，按 `API group/kind` 聚合不同版本、namespace 与插件实例的用量。以下是默认值，字节限制计算序列化记录的 UTF-8 大小：

```yaml
resources:
  maxBytes: 536870912
  defaults:
    maxCount: 10000
    maxBytes: 134217728
    maxResourceBytes: 1048576
    order: released
  kinds:
    aide.dev/Input:
      maxCount: 10000
      order: created
  lowWatermark: 0.8
  dedupSeconds: 604800
  maxReceipts: 100000
```

`kinds` 的字段覆盖 `defaults`。可选排序为 `released`、`created`、`lru`；LRU 由显式读取更新，列表扫描不刷新。排序只用于资源所有者允许释放且无人引用的记录；全局字节压力按释放时间回收。达到硬阈值时尝试回收到 lowWatermark；不足以满足硬阈值则回滚整个写入，返回容量错误。缩小已有记录仍可进行。

去重回执独立限量并在窗口到期后清理。窗口内的重复 Input 只确认已接收，不重新创建或执行；窗口外不承诺永久去重。源水位与待提交引用共同保护 Source 的恢复过程。

这些阈值约束持久 Resource 的逻辑载荷。SQLite 页、索引、WAL，以及 Connector 调用日志、诊断日志、原生 Harness 历史和 Hermes 记忆有各自的存储生命周期；它们不计入此处的 Resource 字节数。

## Route 连续分类与模型

```yaml
plugins:
  personal:
    route:
      contextChars: 16000
```

规则命中立即投递；未命中交给持续复用原生上下文的 Route loop。contextChars 限制新 Input 预览；read_input 提供全文，list_topics 分页读取当前目录。route_input 在同一事务提交唯一当前归属、首次路由回执和 assess，具体契约见 [Route](personal/route.md)。

`harnesses.route.model` 可以独立选择模型，字段同 Pi 的 model；未声明时复用 Chief 启动配置。Route 不可设为 defaultHarness，只拥有路由、目录和共享记忆检索工具，不加载业务执行工具或技能。纯分类失败按输入退避重试，已经完成路由的输入不重复分派。


## Weave 主题整理

```yaml
plugins:
  personal:
    weave:
      enabled: true
      intervalMs: 300000
      maxRoots: 20
      reviewIntervalMs: 3600000
      batchSize: 12
harnesses:
  weave: {}  # 可配置 model，缺省复用 Chief 模型；无通用执行/外发工具
```

周期扫描使用有界候选、搜索和认识指纹；root 超过软目标时提前检查，已检查且未变化的候选按 reviewIntervalMs 重查。每轮最多归组一次，可挂入已有 root 或创建共同父节点。静默优先级来自 lastInputAt，分组和摘要更新不刷新活动时间。具体交接、锁与回收见 [Topic](personal/topic.md)。

## Observation

`observation.captureRequests` 控制 Pi 请求补录，默认关闭。原生 Session 可直接导出；补录的单 Session 和总磁盘预算、查看与导出入口见 [Observation](observation.md)。

## Topic 整理与 root 软目标

```yaml
plugins:
  personal:
    topic:
      maxInput: 40
      maxWork: 8
      maxChildren: 8
    weave:
      maxRoots: 20
      intervalMs: 300000
      reviewIntervalMs: 3600000
      batchSize: 12
```

Topic 阈值按直接归属判断，由空闲 Chief 决定如何整理；Weave 的 maxRoots 统计普通 root，Default 单独兜底，允许无合理归并方案时超标。超过目标时，未变化但已检查的 root 在 reviewIntervalMs 后重查；独立子树有 15 分钟观察期。来源 topicKey 仍保留确定性定位语义。长期设计见 [Topic](topic.md)。
