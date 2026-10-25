# Personal 收敛改动方案

状态：已实现；全项目 TypeScript 类型检查和受影响的 42 个测试文件通过。基于 2026-10-24 合入版本；真实回放的理解质量和 token 收益尚未验收。

## 目标与边界

保持主线：**Channel / Source → Input → Topic → root Chief → Task / Routine 或 Output**。沿用现有领域对象、专属 Agent、parentRef 与 Harness 原生会话。

[Weave](../personal/weave.md) 同时承担知识融合与处理上下文收敛。此次补齐统一沟通接口、扫描覆盖、认识吸收与静默回收，再通过回放衡量理解质量和总推理成本。

## 1. 统一 say 沟通接口

Chief / Task / Routine 共用一个 say tool，表达“给谁、在哪里、发什么”。Agent 根据已有委托判断业务授权；工具验证执行归属、Input 关联和目的地，解析身份，持久化 Output，再交给 Channel 等投递器处理 I/O。Agent 不自行拼装平台请求，也不各自维护选路规则。

### 身份与授权

发送者始终是 Aide 助理。Me 表示被服务者，联系 Me 表示向被服务者沟通；接收者也可以是其他 Person。接口不提供以 Me 身份发言的能力，凭证不能改变这一身份边界。

Aide 可以在已有授权范围内主动联系其他 Person。例如 Me 要求“帮我问下李阳部署进展”，Aide 可以以助理身份向李阳询问，再反馈结果。读取某人的消息、识别其身份或把其 Topic 归组，都不自动授予主动联系权限。沿用 [助理身份契约](../kernel.md#助理定位与身份边界)，无需另建账号权限中心。

### 接口语义与目标解析

三个 Agent 共用 say 和只读 list_contacts；后者分页展示 Person ID / UID、可用 Channel 配置名，不暴露凭证。调用示例：

```ts
say({
  to: { personId: "...", uid: "..." }, // 或 { me: true }
  channelId: "work", // 私聊；群或其他位置使用 target
  text: "..."
})

say({ respondToInputId: "...", text: "..." })
```

respondToInputId 同时提供接收对象和回复位置，与显式目标形式互斥。位置包含 Channel 以及必要的私聊、群聊、话题等 endpoint；平台字段由对应 Channel 解释。

| 沟通表达 | 工具的目的地依据 |
| --- | --- |
| 回复某条消息 | 对应 Channel Input，保留其群聊或话题回复位置 |
| 联系 Me，未指定位置 | 配置的默认 Channel 与该作用域下 Me 的身份 |
| 联系指定 Person，并指定 Channel | 对应作用域下的 Person 身份及明确的沟通位置 |
| 向指定平台目标沟通 | 显式目标地址与适用授权 |

显式 to={me:true} 总是联系被服务者，忽略当前 Input 的隐式回复位置。完全省略收件人和位置时，保留无歧义 immediate Channel Input 的回复规则，否则默认联系 Me。仅有 Person 和 Channel、仍无法确定是私聊还是某个群时，不能任意选择。无效地址、Person 已删除或缺少必要身份时，返回明确的解析失败，不悄悄改投 Me。Person 是可缺失的引用，已持久化 Output 的投递不能依赖 Person 持续存在。

### 职责与持久化

```text
Chief / Task / Routine → say
                         ↓
            解析对象、位置与适用授权
                         ↓
                  持久化 Output
                         ↓
              Channel 等投递器与回执
```

Personal 拥有沟通意图、收件人语义与 Output；应用装配提供配置和 Channel 能力，Channel 负责平台身份与 endpoint 适配。复用现有 say、默认联系 Me 与 Output 投递能力，将分散规则收敛到同一实现。系统恢复通知也复用这套领域能力，无需启动 Agent 来选路。

沿用 [Output](../personal/output.md) 的接纳契约：say 成功返回 Output ID，只表示已持久化受理；送达由独立状态表达。工具调用重试复用原 Output，投递失败不重新执行业务动作；Task / Routine 的 report 与 say 分别确认进展和沟通。Topic 来源地址、主题父子关系不隐式决定发送目标。

中断恢复通知显式表达“联系 Me”，移除仅在 Topic 有 address 时才创建通知的分支。业务进入 uncertain 与通知待办分别持久化；解析失败时保留可恢复的通知待办及原因，不能因工作已标为 uncertain 而永久遗漏。按现有资源事务边界确定最小状态字段，并通过稳定幂等标识避免重复 Output。

代码落点为现有 Personal say 工具装配、应用通信入口、Output 创建与 recoverInterrupted；同步更新 Chief / Task / Routine 提示词和 Output 契约文档。

## 2. Weave Controller 保证扫描覆盖

Controller 决定本轮实际展示的有界候选，记录 UID 与认识版本；Agent 判断分组或不分组。扫描进度按实际覆盖项与分页返回位置推进，不能按请求的 batchSize 或模型 end_turn 推断完成。

沿用 Weave.status 保存进度，统一目录指纹、排序与游标语义。字符预算截断、执行失败或目录变化时，未覆盖项仍进入后续扫描；过期判断不能直接应用于新版本资源。先修复现有周期与阈值触发下的覆盖，再根据实测上下文和 token 成本决定是否增加触发指标。

## 3. root Chief 主动补齐认识吸收

除新 Input 和已配置的定时回顾外，未被父节点吸收的子主题认识版本也应触发当前 root 维护。待吸收状态从子认识版本与父 absorbed 记录推导，避免重复维护知识状态。

同一 root 的维护请求合并并限制频率，由现有 Chief 自底向上吸收，保留来源并记录版本。重启后重新核对，失败退避；不伪造外部 Input，不新增 Agent。

GC 遇到未吸收的静默叶子时，请求吸收并等待重新核对。摘要更新、维护调用和归组不刷新 lastInputAt；回收前仍检查版本、新 Input、执行和持续工作。Default 不参与 Weave，也不删除。

## 4. 共同 root 内减少重复推理

启动时按紧迫性、到达时间，一次原子接纳最多 8 条已积压 Input，保留逐条回执；不增加等待窗口。运行中继续复用 followUp / steer。紧迫输入及时处理，每条 Input 仍有独立消费事实；重复观察可以静默研判，无新增认识时不反复更新 summary。

合批窗口与紧迫性判断属于 Topic / Chief 接纳策略，通过实测延迟和 token 成本确定。root 数量减少不等于调用次数或总 token 自动减少。

## 实施顺序与验收

依次完成统一 say、扫描覆盖、吸收与 GC 闭环，再评估合批。

| 范围 | 关键验收 |
| --- | --- |
| say 与身份 | 三类 Agent 共用接口；联系 Me 和授权联系 Person 均以 Aide 身份发送；回复保留群与话题位置；歧义、无效地址、缺失身份和越界资源访问明确失败；业务授权判断遵守助理身份提示词 |
| 接纳与投递 | 接纳不冒充送达；重试不重复创建；Person / Topic 删除不阻断已有 Output 投递；无 Topic 地址的恢复通知可持久化、可恢复 |
| Weave 覆盖 | 字符预算截断、失败和目录变化后无遗漏；未变化且已扫描的目录不反复消耗模型 |
| 吸收与回收 | 无新 Input 时也能吸收认识并回收合格叶子；嵌套树、重启与失败可恢复；新输入使过期回收决定失效 |
| 合批与价值 | 紧迫消息不被普通批次拖延；逐 Input 回执完整；衡量理解质量、延迟与总 token，计入 Weave、吸收及重试成本 |

通过 [Lark 历史回放](../e2e-lark-replay.md) 比较结果。保留重要变化与来源分歧，不设置强制 Output 压缩配额。已在关键契约的拥有者处补充意图标记及验证场景；当前实现仍需真实回放比较效果，不把单元测试通过等同于产品收益。
