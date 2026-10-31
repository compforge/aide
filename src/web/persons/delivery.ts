import { byId } from '../shared/dom.ts';
import type { PersonDelivery } from '../../../plugins/personal/person/delivery.ts';

const fields = () => ['delivery-window', 'delivery-max', 'delivery-interval'].map(id => byId<HTMLInputElement>(id));
const values = (policy?: PersonDelivery) => [policy?.window?.duration ?? '', policy?.window ? String(policy.window.maxMessages) : '', policy?.minInterval ?? ''];
export function renderDelivery(policy?: PersonDelivery) { fields().forEach((field, i) => { field.value = values(policy)[i]!; }); }
export function deliveryDirty(policy?: PersonDelivery) { return fields().some((field, i) => field.value !== values(policy)[i]); }
export function disableDelivery(disabled: boolean) {
  fields().forEach(field => { field.disabled = disabled; });
  byId<HTMLButtonElement>('delivery-save').disabled = disabled;
}
export function readDelivery(): PersonDelivery | undefined {
  const [duration, count, minInterval] = fields().map(field => field.value.trim());
  if (!!duration !== !!count) throw new Error('统计窗口与最大条数需要一起填写。');
  if (!duration && !minInterval) return undefined;
  return { ...(duration ? { window: { duration, maxMessages: Number(count) } } : {}), ...(minInterval ? { minInterval } : {}) };
}
