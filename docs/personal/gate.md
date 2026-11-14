# Gate：统一对话入口

Gate 是 Me 直接向 Aide 提问、综合信息和交代事情的入口。Web `/gate` 提供持久对话、流式回答、事项和安排；其他入口继续按原有规则进入领域 Topic。

## 身份与生命周期

系统按需创建唯一 `Topic.spec.gate=true`、`id=gate` 的 Gate Topic，承载 Input、Output、Work 与原生 session 的关联。身份不可变，不使用名称识别。Gate 不出现在普通 Topic 导航和 Route 候选中，不参与 Weave，不成为其他 Topic 的父节点，也不能被普通删除、容量回收或空闲 session 释放流程移除。

Gate 没有独立知识维护职责，不自动生成 summary，不产生 review、triage 或 organize Input。领域知识留在原 Topic，跨领域分析成果可由 Gate 所属 Task / Routine 保存。资源引用、Input 完成、Work 完成与 Output 送达仍是独立事实。

## 输入与执行

`POST /gate/messages` 只接受消息 ID 和正文，由服务端固定来源 Web 地址及 Gate Topic。显式规则直接分派，跳过 Route 模型；不按 `sender=Me` 改写其他入口的路由。消息 ID 沿用已有幂等接收机制。

Gate 使用独立 `agents/gate/`、`gate` Harness 和 `gate:<Topic UID>` 原生 session scope，不经过 Chief Agent 装配。Topic 的接收 Controller 仍负责接纳、followUp/steer；agent Controller 将 Gate 交给专用 Reconcile，只处理业务 Input。通用 Pi、Harness 执行和持久会话恢复机制继续复用。

`harnesses.gate.model` 可独立配置，缺省复用 Chief 的已解析模型；`harnesses.gate.packages` 独立配置技能，使用 `aide harness sync gate` 安装。Gate 只暴露业务工具，不装配原生文件、shell 或 Hermes 写入工具。

## 背景与工具

每次模型请求投影 Me、Gate 当前接纳的 Input 和有界 Work 背景，原生会话保留对话连续性。不常驻所有 root Topic 的正文。

| 能力 | 范围 |
| --- | --- |
| list_topics / read_topic | 搜索 root，按需下钻及读取任意 Topic 的 summary、近期 Note |
| list_notes / read_note | 跨 Topic 分页检索和读取，保留 UID、版本及分类 |
| list_inputs / read_input | 定位并追溯保留的原始证据 |
| list_work / read_work | 跨 Topic 查询目标、状态和进展，不启动工作 |
| create_input / create_work / request_work / delete_work | 仅 Gate 所属工作；复用共享 Work 工具及范围校验 |
| assess_input | 确认 Gate Input，可原子交给已有 Gate Work；不能消费领域 Input |
| cite_output / say | 引用实际使用的 Note；回答和工作输出留在 Gate Web 地址 |

读取通常遵循“相关 Topic → summary → 近期 Note / Work → 原始 Input”。summary 不保证包含最新进展。工具返回分页位置时继续补读所需证据，不把预览当全文。Topic 来源链接进入 Topics，Note 来源链接在 Gate 中展开原文；保留的引用不意味着历史版本正文快照，重新打开时展示当前 Note。

全局读取不扩大修改范围。Gate 不装配 Note、summary、Topic 整理工具，也不能操作其他 root 的 Work。工具每次执行重验当前 owner/execution，具体写入继续经过事务校验。

## 直接回答与持续分析

普通查询、解释和跨领域比较由 Gate 直接处理；调用工具或跨 Topic 本身不要求创建 Task。需要独立推进的目标交给 Task，持续职责交给 Routine。创建前检查已有 Work，避免重复推进；第一版不增加 Gate → root Chief 的派发机制，领域工作的变更请求须说明当前能力边界。

Gate 所属 Task / Routine 使用相同的跨 Topic 只读工具，仍只维护自己的状态和 Note。通过 `say` 返回用户可见结果、`report_task` / `report_routine` 确认办理事实；结果默认回到 Gate，不依赖 Me 的默认通知地址。创建与执行异步，Gate 不循环等待 Work 完成。

## 验证

- `tests/gate.test.ts`：固定入口、幂等、持久身份、会话恢复、导航及维护隔离、跨域只读与 Work 修改边界。
- `tests/pi-agent.test.ts` 的 Gate 场景：真实 Pi SDK 和本地脚本模型驱动跨 Topic 读取、引用、Task 创建、结果返回与重启恢复。该测试验证协议和业务链路，不证明真实模型的回答质量。
