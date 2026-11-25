# Aide 文档

Personal 处理持续到来的 Input，关联其中的 Person 和 Address，在 Topic 下积累 Note、推进 Work、通过 Output 与人沟通。底座提供资源协调和 Harness 执行能力。

## 从哪里开始

| 想了解或完成什么 | 阅读入口 |
| --- | --- |
| 配好模型并启动服务 | [配置](configuration.md) → [部署与诊断](deployment.md) |
| 理解个人助手如何处理 Input | [Personal 主流程](personal/README.md#从-input-到认识与成果) · [Input](personal/input.md) → [Route](personal/route.md) → [领域 Chief](personal/chief.md) |
| 办理与沟通 | [办理与沟通](personal/README.md#办理与沟通) · [Work 的选择与生命周期](personal/work.md) · [Output](personal/output.md) |
| 认识与沉淀 | [认识与沉淀](personal/README.md#认识与沉淀) → [普通 Note 的梳理](personal/note.md#梳理与提炼) → 按需复核 [Topic](personal/topic.md)、[Person](personal/person.md) 或 [Address](personal/address.md) 的摘要 |
| 理解待办准备、Deferred 组批与内部维护 | [Secretary](personal/secretary.md) → [Batch](personal/input.md#batch) |
| 改进 Chief 的判断与记忆 | [Topic](personal/topic.md) → [Chief](personal/chief.md) → [Person](personal/person.md) |
| 主题组织、信息收敛与静默回收 | [Topic](personal/topic.md) → [Weave](personal/weave.md) |
| 理解回复与通知的去向 | [Output](personal/output.md) → [Channel](channel/README.md) |
| 接入外部信息 | [Connector 与 Source](connector/README.md) |
| 开发插件或修改底座 | [Kernel](kernel.md) → [Plugin](plugin/README.md) → [Resource](plugin/resource.md) |
| 接入或修改 Agent 执行 | [Harness](harness/README.md) → [Pi](harness/pi.md) |
| 分析 Input 处理与 Agent 上下文 | [Observation](observation.md) |
| 验证真实使用效果 | [E2E](e2e.md) |

## 内容归属

kernel 说明整体边界；plugin / harness 说明通用机制；personal 说明业务对象、Reconciler 角色及其内部 Agent 能力；channel / connector 说明平台接入及覆盖限制。配置参数、操作步骤和真实验收分别以 configuration、deployment、e2e 为入口。

同一行为契约在所属主题中展开，其它文档通过链接引用。设计文档说明当前模型与取舍，字段和局部分支以类型、实现与测试为准；代码中的 @link 指向设计依据。源码地图与修改约束见 [AGENTS.md](../AGENTS.md)。

通用 Spec / Status、Conditions 与版本边界见 [Resource](plugin/resource.md)；Personal 共享片段见[资源状态与组件协作](personal/README.md#资源状态与组件协作)，对象专属字段与行为见各自文档。

- [公共错误契约](errors.md)：AideError、平台错误映射与跨进程诊断。
