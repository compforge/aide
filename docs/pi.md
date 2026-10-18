# 内置 Pi Agent

内置 Agent 位于 `agent/pi/`，用 Pi SDK 提供对话、文件与 CLI 操作，以及 Work 工具。`PiAdapter` 把这个 Agent 接入 Aide 的 Harness 生命周期。Agent 不依赖 Harness Controller，Adapter 不依赖 Personal 业务类型；宿主通过会话工厂把两者装配起来。

```text
宿主绑定 conversationId → Personal WorkService → Work Resource → Personal Reconcile
                                 ↑
                           Pi Work tools
                                 ↑
Harness Controller → PiAdapter → 内置 Pi Agent → Pi 模型与原生工具
```

## Work 工具

| 工具 | 行为 |
| --- | --- |
| `list_work` | 列出绑定对话中的 Task / Routine |
| `read_work` | 读取目标、进度、历史、当前 revision 和待回答问题 |
| `create_work` | 创建有限目标或持续安排，唤醒已有 Reconcile |
| `update_work` | 修改定义、转换类型、补充回答、暂停或恢复 |
| `delete_work` | 删除工作并停止未来调度，保留对话消息和入站去重记录 |

普通问答和即时查询可以直接使用原生工具，不要求创建 Work。工具返回持久化后的状态；创建成功不表示目标完成。读取不会唤醒执行，更新和删除需要最近读取的 revision。工具没有任意写 status 的入口，执行是否完成由 Work Reconcile 决定。

WorkService 与 Channel 输入共用 Personal 的创建、更新规则及 Store。工具使用宿主绑定的 conversationId，不接受模型另传一个对话范围。删除不撤销外部动作、不取消已运行的命令；运行结果通过 uid 读取原资源，删除后不能重建它。删除前将 outbox 和输入回执归档至 Conversation，保留 Channel 投递与去重依据。删除请求立即使工作退出可见列表，物理清理由既有 Resource 删除生命周期完成。

## 装配

在已启动的 Aide 宿主中，绑定一份对话范围，再将工厂交给 Harness registry：

```ts
import { createPiAgent } from "../agent/pi/agent.ts";
import { createHarnessAdapter } from "../src/runtime/harness/registry.ts";

const work = aide.work(conversationId);
const adapter = createHarnessAdapter(
  { id: "assistant", harness: "pi" },
  {
    ...ports, // Controller 提供 openInteraction、log、nativeEvent
    targetConfig: { harness: "pi" },
    piSession: (options) => createPiAgent({
      ...options,
      work,
      sessionDir: "/path/to/aide/pi-sessions",
      agentDir: "/home/user/.pi/agent",
      model: { provider: "your-provider", id: "your-model" },
    }),
  },
);
```

`agentDir` 省略时使用 Pi 默认配置目录，模型省略时使用 Pi 的选择机制。凭证和模型端点由 Pi 的 `auth.json`、`models.json` 及环境配置管理；Aide 不保存另一份凭证。Pi 模型配置格式见 [官方文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)。SDK 固定版本随 lockfile 安装。

原生会话由 Pi 自己持久化。Adapter 将会话 id 和文件路径通过 Harness binding 保存。Pi 在第一条对话消息时创建文件，因此 binding 区分尚未落盘的空会话和已有历史：空会话可以重新建立，已有历史恢复时要求文件存在且工作目录、对话范围一致。内置 Agent 加载工作目录的上下文与 Skills，启用明确列出的文件、CLI 和 Work 工具；不自动加载扩展、提示词命令或交互主题。

## 执行契约

每个 Pi 会话一次执行一个 Turn，忙时拒绝新输入，由 Controller 排队。当前提供文本输入、取消、关闭和持久会话恢复，不声明同轮 steer 或媒体能力。嵌入式 SDK 不支持每会话修改进程环境，账户配置使用独立 agentDir。

Adapter 记录原生工具开始与结束、消息和 token 用量。一次 Pi 运行可能包含多轮工具调用；只有收到 `agent_settled` 且最后模型响应以正常 stop 结束，才将其标为最终答案。对话进度保留在 agentText，最终答复进入 finalText。等待 Pi prompt 调用栈结束后才释放执行位，防止下一轮撞上尚未清理完的原生会话。

失败、取消、截断和空答复不能伪装成成功。Adapter 对已接收的 Turn 恰好发一次 idle，错误先发诊断事件。内置 Agent 禁用自动整轮重试，模型连接空闲超时为 60 秒；完整执行期限仍由 Harness 调用方管理，HTTP 连接管理沿用 Pi SDK。

## 验证与接入边界

`tests/pi-agent.test.ts` 运行真实 Pi SDK 和本地模拟模型 HTTP 服务，覆盖直接回答、全部五个 Work 工具、原生会话恢复、最终答案提取、模型失败和取消。`tests/pi-work.test.ts` 覆盖持久化、revision 冲突、对话范围、删除后消息保留，以及真实 Personal Worker 被工具写入唤醒。

`npm start` 的网页／飞书入口由 Chief 使用 Pi 接话，Work Controller 使用 Codex 执行长期工作。Chief 的 Source 输入、连接器工具与持久问答见 [Chief 与主动发现](chief.md)。`tests/chief.test.ts` 验证完整装配；这些协议测试不代表真实模型的意图识别效果或业务 CLI 已验证。
