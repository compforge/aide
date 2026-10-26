# Input：事实与处理痕迹

Input 保存收到的内容及来源证据，各组件在同一资源上留下自己的处理进展。它使一条信息从接收到路由、研判和办理的过程可追溯；输入数量与输出数量没有一对一关系。

## 内容、身份与调度

| 信息 | 含义 |
| --- | --- |
| text、observation | 可读事实正文与来源原始证据；不混入 Chief 指令 |
| origin、originId、originRef | Channel / Source / Chief 分类、来源定义与可选观察资源引用 |
| sender、relation | 可选的 Person，以及输入相对于 Me 的关系 |
| source | 可选 Address，表示事情发生或可以联络的位置 |
| topicId、topicKey | TopicLocator 提供的精确 Topic ID 或稳定来源关联键 |
| topicName | 来源提供的初始名称建议；不参与匹配，不覆盖既有 Topic 名称 |
| attention | immediate 或 deferred，表达处理紧迫性 |

字段的完整类型与必选性见 [InputSpec](../../plugins/personal/input/model.ts)。人物、地址、话题线索和调度分别回答不同问题；紧迫性、来源和 relation 都不自动授予执行权限或要求外发。

Channel / Source 经绑定的入口提交 Input，稳定身份用于传输去重；接收回执只证明持久化成功。Source 先保存 Input，再推进观察水位。原始消息满足提交条件时，即使可选上下文读取失败仍可接收，具体证据与权限见对应接入文档。

## 路由、研判与办理

| status 阶段 | 写入者与完成条件 |
| --- | --- |
| route | Route 的规则或 route_input 保存完整去向与理由 |
| assess[Topic UID] | Chief 用 assess_input 确认本话题的研判 |
| handle[Work UID] | Work 应用请求，再用 report_task / report_routine 确认办理 |

route_input 在同一事务写入 route 结果和全部 assess；assess_input 在同一事务完成研判并建立必要的 handle。目标引用固定 UID，不能把旧实例的请求转给同名新资源。一个 Input 可以关联多个 Topic、多个 Work，各自独立确认。

未完成可能是尚未接纳、运行、退避或待核对。接纳记录不等于完成；原生调用结束也不代替工具回执。Route 分类失败可以按输入退避重试，Chief / Work 可能已经产生副作用，需核对后继续。详细策略分别归 [Route](route.md)、[Topic](topic.md)、[Task](task.md) 与 [Routine](routine.md)。

## 研判与办理

Chief 可以直接处理、创建或删除工作。将现有 Input 交给已有 Work 时，通过 assess_input 同时完成研判和建立 handle，原始事实只保存一份。一个 Input 可以由多个 Chief 独立研判，也可以交给多个 Task / Routine 办理；每个资源按 UID 拥有自己的记录。

request 支持 context、update、pause、resume、answer；交接说明 note 与原文分开保存，update 的 changes 包含 title、instruction、trigger。Source 观察只能提供 context，不能作为控制授权。已有 handle 的请求不可替换；后来的独立请求必须有新 Input 身份。

`request_work({ workId, text, action?, changes? })` 用于 Chief 独立形成的新请求，创建 origin=chief 的新 Input，按工具调用身份去重，直接建立目标 handle。针对已收到 Input 的交接使用 assess_input，避免复制原始消息。

Task / Routine Watch Input.handle 并按自身 UID 索引读取未完成记录。Reconcile 原子应用确定性请求并记录 appliedAt；暂停或拒绝请求可直接完成，其余材料必须由执行确认。Task / Routine 的后续输入通过原生 followUp / steer 进入当前 invocation，分别经 report_task / report_routine 独立确认。原始 Input 不复制到 spec。

暂停、结果未知的工作可吸收事实但不因此恢复。显式更新可为已完成目标提出新的要求；失败请求保存 rejected 原因而不阻塞后续输入。目标删除会把剩余 handle 标为 cancelled。

## 查询、保留与展示

待办事实保存在 Input.status。Definition.indexes 为 routePending、assess / assessPending、handle / handlePending 提供按阶段和资源 UID 的查询，消费方按索引读取。索引与资源更新在同一事务提交，机制见 [Resource](../plugin/resource.md#索引)。

全部阶段完成后 Input 才可进入容量回收候选；Source 的未提交引用仍可保护它。目标删除明确取消剩余阶段。处理痕迹随 Input 保留，入站去重回执有独立的有界窗口；窗口内重投不会让已回收输入重新执行。用户核对后重新交办是新的 Input。

InputPrinter 同步处理资源快照，describe 保留正文、来源、人物关系与 observation，summarize 生成有界单行预览。Web 和 Agent 读取同一事实表达，打印不会查询外部上下文或调用模型。全文按需分页读取，预览预算不等于模型上下文窗口。

## Web 检索与处理 Timeline

Web 的 Inputs 页查询 Personal 全局 v1 目录中的保留输入，包括尚未路由和静默处理的输入。Connector 从已持久化的来源地址或观察事实识别，来源类型使用 origin / originId，具体观察源使用 originRef 的 UID；删除或停用 Source 不会抹去已有输入的来源选项。正文检索、状态条件与来源条件均在分页前应用。

处理 Timeline 读取同一 Input 的 route / assess / handle。分派、最近记录的执行开始、请求应用、完成回执分别展示；目标实例不存在时保留记录但不链接同名新实例。处理完成要求 route 和所有已分派消费者都完成，不以 Output、原生执行结束或 Work 的当前状态代替。

Output 只在其 inputIds 显式包含当前 Input 时关联，不按相邻顺序、相同 executionId 或相似正文推断。Output 的创建与投递是独立事实；没有关联 Output 也可以是正常的静默处理。

现有 Input status 并非逐次追加的审计日志；重复执行可能只保留最近的 startedAt / executionId 和异常信息。界面展示路由尝试次数与计划重试时间，异常没有独立时间戳时明确显示时间未记录，不能伪装成完整历史。重启后仍可读取保留的回执与 Output，Input 被容量回收后详情返回不存在。

## 验证

`tests/route.test.ts` 覆盖原子分派与重试；`tests/input-assessment.test.ts` 覆盖研判、办理交接和释放；`tests/work-context.test.ts` 覆盖精确确认与事务回滚；`tests/topic-intake.test.ts` 覆盖接收与重投。

`tests/input-browse.test.ts` 覆盖筛选后分页、来源选项、稳定排序、消费回执终态、独立消费者、已删除目标、明确 Output 关联及 HTTP 页面与查询。

自动送入 Route / Chief / Task / Routine 的预览保留正文、来源与身份信息，不展开 observation；有证据时附上 read_input 入口说明，正文超预算时明确提示截断。原始证据和完整正文仍由 InputPrinter.describe 提供，Web 与按需读取不丢失信息。预览减少每轮重复携带的材料，不改变输入的路由、处理确认或保留策略。
