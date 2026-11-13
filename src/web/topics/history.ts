import type { TopicBlock, TopicView } from "../../channel/view.ts";

interface HistoryRequest { before: string; until?: Set<string> }
const facts = (view: TopicView) => view.blocks.filter(block => block.type === "input" || block.type === "message").map(block => block.id);

/**
 * @spec Loaded history survives rolling live snapshots; older responses never overwrite newer blocks.
 * @spec Reconnection gaps are filled with bounded pages, independently of the oldest reading cursor.
 * @why SSE remains a ten-record live window even after the reader has loaded a long transcript.
 * @link docs/channel/web.md#实时进展与历史
 */
export function createDialogueHistory() {
  const blocks = new Map<string, TopicBlock>();
  const gaps: HistoryRequest[] = [];
  let latest: TopicView | undefined;
  let before: string | null | undefined;
  function live(view: TopicView) {
    const known = new Set([...blocks.values()].filter(b => b.type === "input" || b.type === "message").map(b => b.id));
    const incoming = facts(view);
    if (known.size && incoming.length && !incoming.some(id => known.has(id)) && view.meta.before) {
      gaps.push({ before: view.meta.before, until: known });
    }
    if (!latest) before = view.meta.before;
    latest = view;
    const executionIds = new Set(view.blocks.filter(b => b.type === "execution").map(b => b.id));
    const retired = new Set([...blocks.values()].filter(b => b.type === "execution" && b.status === "running" && !executionIds.has(b.id)).map(b => b.id));
    for (const [id, block] of blocks) {
      if (retired.has(id) || (block.parent_id && (executionIds.has(block.parent_id) || retired.has(block.parent_id)))) blocks.delete(id);
    }
    for (const block of view.blocks) blocks.set(block.id, block);
  }
  function next(older: boolean): HistoryRequest | undefined {
    return gaps[0] ?? (older && before ? { before } : undefined);
  }
  function accept(request: HistoryRequest, page: TopicView) {
    if (page.meta.before === request.before) throw new Error("History pagination did not advance");
    for (const block of page.blocks) if (!blocks.has(block.id)) blocks.set(block.id, block);
    if (request.until) {
      if (!page.meta.before || facts(page).some(id => request.until!.has(id))) gaps.splice(gaps.indexOf(request), 1);
      else request.before = page.meta.before;
    } else before = page.meta.before;
  }
  function view(): TopicView | undefined {
    if (!latest) return;
    const children = new Map<string, TopicBlock[]>();
    for (const block of blocks.values()) if (block.parent_id) {
      const group = children.get(block.parent_id) ?? []; group.push(block); children.set(block.parent_id, group);
    }
    const roots = [...blocks.values()].filter(b => !b.parent_id).sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "") || a.id.localeCompare(b.id));
    return { ...latest, blocks: roots.flatMap(block => [block, ...children.get(block.id) ?? []]) };
  }
  return { live, next, accept, view, hasOlder: () => !!before, hasGap: () => gaps.length > 0 };
}
