# Pi Harness

Pi 是通用 Harness，使用 `agents/pi/` 中的 Pi Agent 和 `PiAdapter` 提供模型对话、文件与 CLI 操作。它不依赖 Personal，也不预装 Work、问答或 Connector 业务工具。共同执行契约见 [Harness](README.md)，Personal 版本见独立的 [Chief](chief.md)。

## 会话与能力

通用 Agent 创建 Pi SDK 会话，加载工作目录上下文与 Skills，启用文件和 CLI 原生工具。调用方可以注入提示词、工具与会话范围。默认使用 Pi 的提示词，不承担 Chief 的工作识别与主动发现策略。

PiAdapter 处理 open、sendTurn、cancel、close、事件归一和恢复句柄，不解释工具背后的业务含义。每个原生会话一次执行一个 Turn，忙时由宿主排队；当前支持文本输入、取消与恢复，不声明媒体或同轮 steer 能力。

## 装配与模型配置

Task / Routine 默认使用通用 Pi。Aide 在启动时从 `harnesses.pi.model` 和 `harnesses.pi.packages` 准备模型与技能；能力包通过 `aide harness sync pi` 显式同步，与 Chief 分别存放。

通用 Pi 也可以直接通过注册表创建，不需要 Personal：

```ts
const piConfig = await resolvePiConfig({ cwd });
const adapter = createHarnessAdapter(
  { id: "general", harness: "pi" },
  { ...ports, piConfig, targetConfig: { harness: "pi" }, rootDir: aideHome },
);
```

启动装配调用 `resolvePiConfig` 读取 Pi settings/models 并应用显式覆盖，传入 `piConfig`。需要绑定自定义工具时提供消费该配置的 `piSession` 工厂。模型定义和 settings 保留在内存中，SDK refresh 不重新读取原文件；认证沿用 Pi auth.json 和 SDK 的刷新机制，默认目录为 `~/.pi/agent`。嵌入式 SDK 不支持每会话环境覆盖。配置格式见 [Pi 上游文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)。

原生会话由 Pi SDK 按默认布局持久化在 `<agentDir>/sessions/<encoded-cwd>/`，通常为 `~/.pi/agent/sessions/` 下的目录；指定 agentDir 时也由 SDK 选择对应路径。Pi 自己按 cwd 组织文件，不意味着 Aide 恢复 Project 分组。通用 Pi 和 Chief 都沿用此机制，Aide 不再指定 pi-sessions / chief-sessions 目录。Adapter 保存文件位置与恢复状态。恢复时校验工作目录与调用方绑定的范围。尚未落盘的空会话可以重新建立，已有历史文件缺失或范围不符则报错。

Agent 不自动发现环境中的扩展、提示词命令或交互主题；装配方可通过 extensionPaths 显式提供扩展路径，工具和钩子由 Pi SDK 加载。Adapter 负责扩展启动与退出事件。通用 Pi 默认不携带记忆扩展，并禁用自动整轮重试。完整执行期限由 Harness 调用方管理。

## 输出与验证

Adapter 将文字、思考、工具和用量转换为 Core 事件。多轮工具调用中的中间发言保留为进度，只有成功收口的最后答复进入 finalText；失败、取消、截断或空答复不作为成功结果。原生调用栈清理完毕后才释放执行位。

`tests/pi-agent.test.ts` 使用真实 SDK 与模拟模型验证通用工具集合、原生历史恢复、范围拒绝、流式输出、失败与取消。Chief 复用这套机制，其业务链路和优化方向见 [Chief](chief.md)。
