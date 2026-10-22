import { byId as $, newId } from '../shared/dom.ts';
import { request, errorMessage } from '../shared/http.ts';
import type { ConversationItem } from '../../api/types.ts';

/** @spec A failed submission keeps its original message ID; editing the text starts a new submission. */
export function mountComposer(conversationId: string, onAccepted: () => Promise<void>) {
  let sending = false;
  let draft: { id: string; sessionId: string; text: string } | null = null;
  $<HTMLFormElement>('composer').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $<HTMLTextAreaElement>('input').value.trim();
    if (!conversationId || !text || sending) return;
    sending = true; $<HTMLButtonElement>('send').disabled = true; $<HTMLTextAreaElement>('input').disabled = true;
    $('notice').className = ''; $('notice').textContent = '正在理解你的请求…';
    try {
      if (!draft || draft.text !== text) {
        const conversations = await request<ConversationItem[]>('/conversations');
        const sessionId = conversations.find((item) => item.id === conversationId)?.sessionId || conversationId;
        draft = { id: newId(), sessionId, text };
      }
      await request('/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) });
      draft = null; $<HTMLTextAreaElement>('input').value = ''; $('notice').textContent = '已接收，后续进展会显示在这里。';
      await onAccepted(); $('messages').scrollTop = $('messages').scrollHeight;
    } catch (error) { $('notice').className = 'error'; $('notice').textContent = errorMessage(error) + ' 原消息编号会保留，避免重复交办。'; }
    finally { sending = false; $<HTMLButtonElement>('send').disabled = false; $<HTMLTextAreaElement>('input').disabled = false; $<HTMLTextAreaElement>('input').focus(); }
  });
  $<HTMLTextAreaElement>('input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $<HTMLFormElement>('composer').requestSubmit(); }
  });
}
