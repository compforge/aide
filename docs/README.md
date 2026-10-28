# Aide 文档

Aide 通过 Channel 与 Source 接收事实，由 Personal 判断、推进已有委托，并在需要沟通时产生 Output。底座提供资源协调和 Harness 操作能力。

## 从哪里开始

| 想了解或完成什么 | 阅读入口 |
| --- | --- |
| 配好模型并启动服务 | [配置](configuration.md) → [部署与诊断](deployment.md) |
| 理解个人助手如何工作 | [Personal](personal/README.md) → [Input](personal/input.md) → [Route](personal/route.md) |
| 改进 Chief 的判断与记忆 | [Topic](personal/topic.md) → [Chief](personal/chief.md) → [Person](personal/person.md) |
| 主题组织、信息收敛与静默回收 | [Topic 设计](topic.md) → [Weave](personal/weave.md) → [Topic 契约](personal/topic.md) |
| 持续推进目标或职责 | [Task](personal/task.md)、[Routine](personal/routine.md) |
| 理解回复与通知的去向 | [Output](personal/output.md) → [Channel](channel/README.md) |
| 接入外部信息 | [Connector 与 Source](connector/README.md) |
| 开发插件或修改底座 | [Kernel](kernel.md) → [Plugin](plugin/README.md) → [Resource](plugin/resource.md) |
| 接入或修改 Agent 执行 | [Harness](harness/README.md) → [Pi](harness/pi.md) |
| 分析 Input 处理与 Agent 上下文 | [Observation](observation.md) |
| 验证真实使用效果 | [E2E](e2e.md) |

## 内容归属

kernel 说明整体边界；plugin / harness 说明通用机制；personal 说明业务对象、Agent 角色和决策；channel / connector 说明平台接入及覆盖限制。配置参数、操作步骤和真实验收分别以 configuration、deployment、e2e 为入口。

同一行为契约在所属主题中展开，其它文档通过链接引用。设计文档说明当前模型与取舍，字段和局部分支以类型、实现与测试为准；代码中的 @link 指向设计依据。源码地图与修改约束见 [AGENTS.md](../AGENTS.md)。

改动方案与验收范围：[Personal 收敛改动](plans/personal-convergence.md)（已实现）。

- [资源状态与组件协作](status.md)：共享状态、Conditions、Task/Routine 完成语义与 API 版本边界。
