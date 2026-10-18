# Pi 与 Chief Harness

`pi` 和 `chief` 是两个可独立选择的 Harness。它们共用 Pi SDK 和 `PiAdapter` 的执行机制；差异在于 Agent 的职责、提示词和工具。配置、日志及执行记录使用各自的 Harness 身份。

| Harness | Agent | 能力 |
| --- | --- | --- |
| `pi` | `agents/pi/` | 通用对话、文件与 CLI 工具，加载工作目录上下文与 Skills |
| `chief` | `agents/chief/` | 通用 Pi 能力，加上 Personal 提示词、Work 工具，以及装配注入的问答和 Connector 工具 |

## Agent 与 Adapter

通用 Pi Agent 创建 SDK 会话，管理模型配置、原生工具和会话文件，不依赖 Personal 类型。调用方可以注入提示词、工具和会话范围。

Chief Agent 调用通用 Pi 工厂，绑定 WorkService 并添加业务工具；Work 状态、Controller 和调度仍由 Personal 拥有。Chief Controller 通过 Harness 调用这个 Agent，具体决策规则见 [Personal](personal.md)。

PiAdapter 负责 open、sendTurn、cancel、close、事件归一与恢复句柄，不解释 Work 或 Connector。注册表为 `pi` / `chief` 创建相应身份的 Adapter；Chief 的会话工厂必须由 Personal 装配提供，不能默默回落为无业务工具的 Pi。

```text
Harness registry
├── pi    → PiAdapter(pi)    → agents/pi
└── chief → PiAdapter(chief) → agents/chief → agents/pi
                                  │
                        WorkService / 问答 / Connector
```

## 装配与配置

通用 Pi Harness 可以直接创建，不需要 Personal：

```ts
import { createHarnessAdapter } from "../src/host/harness/registry.ts";

const adapter = createHarnessAdapter(
  { id: "general", harness: "pi" },
  { ...ports, targetConfig: { harness: "pi" }, rootDir: aideHome },
);
```

宿主提供自定义 Pi 会话工厂时使用 `piSession`。Chief 则使用 `chiefSession`，由 Personal 将 conversationId、WorkService、问题回调和连接器工具绑定到同一会话：

```ts
const adapter = createHarnessAdapter(
  { id: chiefTargetId, harness: "chief" },
  { ...ports, targetConfig: { harness: "chief" },
    chiefSession: aide.chiefSession(chiefTargetId) },
);
```

模型和凭证由 Pi 的 `auth.json`、`models.json` 与环境配置管理，默认目录为 `~/.pi/agent`。工厂可指定 agentDir 与模型；Aide 不另存模型凭证。`AIDE_MODEL` 控制默认 Codex Target，不改变 Chief 的 Pi 模型。Pi 模型配置见 [上游文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)。

原生会话由 Pi SDK 持久化，Adapter 保存文件位置与恢复状态。通用 Pi 与 Chief 使用各自的会话范围；恢复时校验工作目录和范围，Chief 的范围绑定 conversationId。空会话尚未落盘时可以重新建立，已有历史文件缺失或范围不符则报错，避免悄悄换成新会话。

## 执行与展示

每个 Pi 会话一次执行一个 Turn，忙时由 Controller 排队。当前支持文本输入、取消与恢复；嵌入式 SDK 不支持每会话环境覆盖。Agent 不自动加载扩展、提示词命令或交互主题。

Adapter 将文字、思考、工具和用量转换为 Core 事件。一次运行可能经历多轮工具调用；只有成功收口的最后模型答复进入 finalText，中间输出留作进度。取消、失败、截断或空答复不能作为成功结果。原生调用栈清理结束后才释放执行位。

内置 Agent 禁用自动整轮重试，完整期限由 Harness 调用方管理。Pi / Chief 共用同一套流式与取消逻辑；网页消费这些事件的方式见 [Web](web.md)。

## 验证

`tests/pi-agent.test.ts` 使用真实 SDK 与模拟模型，检查通用 Pi 的工具集合、Chief 的五个 Work 工具、身份与会话恢复边界、流式回复、失败和取消。`tests/chief.test.ts` 验证 Source → Chief → 用户决定 → Work 的完整装配。它们不代表真实模型判断质量或业务账号已经验证。
