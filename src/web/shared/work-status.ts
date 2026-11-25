import type { TopicWork } from '../../api/types.ts';

export const workStatusLabels: Record<TopicWork['status'], string> = { open: '跟进中', closed: '已收尾', ready: '准备执行', running: '执行中', waiting: '等你回答', scheduled: '等待触发', paused: '已暂停', done: '已完成', uncertain: '需要核对结果', invalid_result: '结果解析失败' };
