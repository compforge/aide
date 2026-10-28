# Weave：知识融合与处理上下文收敛

## 整体定位

Weave 将不同来源、不同领域但存在有价值联系的 Topic 组织到共同上下文，让知识相互解释、补充和启发，同时收敛独立处理上下文，控制路由与推理成本。

它作用于 [Personal 主流程](README.md#对象与主流程) 中的 Topic 关系：**Channel / Source → Input → Topic → root Chief → Task / Routine 或 Output**。Input 保留路由记录，由当前归属 Topic 的 root Chief 综合处理。

### 两个目标

| 视角 | 目标 | 判断依据 |
| --- | --- | --- |
| 学习 | 让不同来源、领域的知识在共同上下文中融合，形成更完整的理解 | 是否发现因果、影响、分歧或机会，并形成有证据的判断与有价值的输出 |
| 工程 | 收敛 root，缩短 Route 候选上下文，减少独立 Chief 与重复推理 | 实际上下文大小、模型调用频率和总 token 成本 |

例如，环境中的内存异常、客户反馈的响应变慢、需求中的配额调整计划，可能共同解释一次服务问题。分组依据是共同理解的价值，不局限于关键词相似；跨领域关联仍需要证据，不能把假设写成事实。

融合后的认识保留来源、作者、确认状态、分歧和授权边界，遵守 [助理身份契约](../kernel.md#助理定位与身份边界)。容量压力决定整理的紧迫程度，有意义的联系决定哪些主题可以归组；无合理关联的主题保持独立，Route 的有界分页继续保障上下文预算。

### 收敛什么

当前用树表达整理结果：A 挂到已有 B，或 A、B 产生共同父主题 C。后续由当前 root 的 Chief 综合查看子树材料。Weave 的长期意图是理顺信息，未来是否扩展交叉关联或其他结构，由实际需要决定。

需要区分三个量：

- root 数量：A、B 归组到 C 后，从两个独立处理上下文变成一个。
- Topic 总量：这次归组由两个节点变成三个，必须结合静默回收控制长期保留规模。
- Chief 实际调用次数：共同 root 仍可能被每条输入唤醒，需要合批通知与按需研判才能减少推理。

完整闭环是：**Weave 收敛 root → root Chief 吸收子主题认识 → 静默叶子回收 → 控制 Topic 总量。** 活跃主题数不受静默回收的硬上限约束；Default 不参与归组与删除。

### 分层收敛设计

Route 初分、Chief 闲时下沉与拆分、Weave 全局归拢的目标模型见 [Topic 的分层整理与收敛](topic.md#分层-topic-的整理与收敛)。Chief 负责可调整归属与状态驱动维护，Weave 负责软 root 目标。

## CRD

`aide.dev/v1alpha1 Weave/global` 是全局主题整理协调资源。

### Spec

spec 为空对象；enabled、maxRoots、检查间隔、候选批量等策略来自 plugins.personal.weave 配置。

### Status

agent / execution 保存本轮原生会话与执行；nextAt / lastRunAt 保存检查计划与最近启动时间；reviewed 按 Topic UID 保存已展示的候选版本和检查时间。候选版本包含视图契约，旧的检查结果不能替代当前主题事实。

## Reconciler

### 职责与策略

Weave Agent 判断关联价值，Controller 负责有界候选、扫描覆盖和调用预算；分组只调整关系，不冻结执行或搬迁数据。周期整理和 maxRoots 软数量目标共同决定检查时机；最久没有新 Input 的主题优先检查，静默本身不证明相关。

每轮使用新的原生会话，当前知识来自 Topic CRD，扫描进度保存在 Weave CRD；上轮会话只保留为执行证据，不承接下一批判断，避免历史压缩把旧规则和过期目录固化成约束。失败后的下一批同样读取当前资源，已生效的父子关系参与候选筛选。

本轮上下文分别说明全局普通 root 数、待检查数和实际候选；搜索工具另行说明全局数与匹配数。一条待检查候选也可以查找批外已有 root 并挂入其中，已有子节点的 root 可以继续组织。检查结果绑定候选视图契约与 Topic 认识版本；契约改变时，旧结果失效一次，存量主题重新获得检查机会。正常结束只确认本批已检查，不代表已经归组或达到数量目标。超过软目标时，已检查且未变化的 root 在 reviewIntervalMs 后重新获得检查机会；近期独立的子树保留 15 分钟观察期，归组时读取其拆分原因。已有父主题仍可继续接纳相关 root。

主题树与 Chief 接管见 [Topic](topic.md#agent-触发边界)。Weave 归组保留 Input 的当前归属，主题关系不产生通信目的地或外发授权。认识吸收和静默回收分别由 Topic / Chief 与生命周期协调负责，Weave 不替代它们。

### 扫描与触发

Weave 的 Reconcile 按周期或 root 数量压力选择有界候选，再触发 Weave Agent。默认 maxRoots=20、reviewIntervalMs=3600000、intervalMs=300000、batchSize=12，压力触发的调用间隔至少为 min(30000, intervalMs)。每轮最多分组一次。

扫描进度按 Topic UID 保存实际展示的名称/summary 与候选视图契约版本和检查时间；Note 单独变化不使已检查的版本失效。未检查的 Topic 优先，已变化的 Topic 按上次检查时间轮转；单个 Topic 的变化不重置其它进度。lastInputAt 只影响静默排序，不使已检查的认识失效。失败不确认覆盖；检查期间发生变化的 Topic 会再次进入候选；离开 root 集合的记录被清理。

## Agent

### Context View

Weave 每轮使用新的原生会话，避免历史中的目录和规则固化成当前依据。Context View 的文本大纲如下：

```text
system
  助理身份与归属规则
  Weave：只依据当前 root 事实；有价值的联系才归组
  不归组 Default；不回复用户、不创建工作；每轮最多归组一次
user：动态身份背景（如已配置 Me）
user：本轮检查请求
  rootCount：普通 root 总数
  maxRoots：软目标；pendingCount：待检查数
  candidates：本批有界候选的 UID、名称、summary、版本与组织调整依据
assistant / tool
  list_topics：搜索批外相关 root，区分全局数与匹配数，附近期相关人物预览
  read_topic：分页补读当前认识、拆分原因及近期相关人物预览
  group_topics：校验所读版本后提交一次归组
```

候选批量小不代表全局 root 少；只有一条候选也可寻找批外已有父主题。主题内容是证据，不是指令；信息不足时可以不归组。当前身份背景通过 Background 通道提供，本批候选由 Reconciler 的激活请求提供。


共同人物仅作关联线索，必须结合主题内容与活动判断，不按人物交集数量自动归组；Me 的广泛出现尤其不能充当归组理由。人物视图是有界派生样本，缺省或为空不证明无关，见 [Topic 近期相关人物](topic.md#近期相关人物)。

### 当前操作：组织 Topic 关系

`group_topics` 支持将 1–8 个 root 挂到已有 root，或为 2–8 个 root 创建共同父 Topic。已有父节点保留名称、认识和 trigger 开关；新父节点使用默认 trigger 配置和 Weave 提供的综合认识。Default 不参与分组。

Input、Task、Routine 通过 status.topic 保存当前归属。初次路由确定 Input 归属，Chief 创建 Work 时使用自己的 Topic；空闲整理可在树内调整归属。root 只表示当前处理入口。例如 topic1 的 Chief 因 input1 创建 task1，二者都留在 topic1；topic1 挂到 topic2 后，topic2 的 Chief 根据 topic1 的新 Input 创建 task2，task2 属于 topic2。父 Chief 可以查看、操作子树已有 Work，并在 Work 空闲时调整其归属。

候选必须是存活、非 Default 的 root，使用 UID 与认识版本核对。父子关系提交使用资源版本校验并拒绝环；分组事务只更新关系和父节点状态，不扫描或迁移 Input / Work，也不等待 Chief 或 Work 结束。创建父 Topic 需要先取得宿主分配的 UID，随后原子提交全部父子关系；提交失败清理未使用的新父节点。

旧 Chief 运行期间允许其 Topic 成为子节点。旧执行可自然完成、提交研判和认识；后续不再为子 Topic 启动 Chief。子认识的后续变化由当前 root 吸收。已有材料可以被新旧 Chief 查看，不通过 Input 占有锁阻止重复研判。

## 效果验证

| 维度 | 观察内容 |
| --- | --- |
| 理解质量 | 跨来源关联是否有依据，分歧是否保留，输出是否帮助用户了解、决定或推进事情 |
| 上下文规模 | root 数、Topic 总数、Route / Chief 背景大小及按需读取量 |
| 推理成本 | Chief、Route、Weave、认识吸收和重试的调用次数与 token 总量 |
| 响应质量 | 紧迫输入延迟、遗漏、重复沟通及无价值打扰 |

root 数下降本身不能证明收益；必须计入整理成本，并确认重要变化没有因压缩而漏报。验证使用 [历史回放](../e2e-lark-replay.md)，不把输出数量作为强制配额。覆盖、吸收与合批的验收见 [Topic](topic.md#落地范围与验收)及 tests/weave.test.ts。
