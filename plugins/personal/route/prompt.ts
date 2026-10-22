import type { ConversationResource } from "../conversation/model.ts";
import { inputPrinter } from "../input/printer.ts";
import type { RoutingInput } from "./delivery.ts";
import { routePolicy } from "./config.ts";

/** @spec Every live Conversation remains a candidate; prompt limits shrink previews or the batch, never drop candidates silently. */
export function routePrompt(inputs: readonly RoutingInput[], conversations: readonly Readonly<ConversationResource>[], policy: ReturnType<typeof routePolicy>) {
  const candidates = conversations.filter(c => !c.metadata.deletionTimestamp).map(c => ({ name: c.metadata.name, uid: c.metadata.uid, id: c.spec.id,
    nameHint: c.spec.name ?? c.spec.id, default: !!c.spec.default,
    summary: (c.status.batch?.result?.context ?? c.status.batch?.result?.summary ?? c.status.batch?.context.history ?? "").slice(0, policy.summaryChars) }));
  // Reserve half the context for input previews. An oversized catalog is explicit, never silently incomplete.
  while (JSON.stringify(candidates).length > policy.contextChars / 2) {
    if (!candidates.some(c => c.summary.length)) throw new Error("Route Conversation catalog exceeds contextChars; increase the Route context budget");
    for (const c of candidates) c.summary = c.summary.slice(0, Math.floor(c.summary.length / 2));
  }
  const selected: Array<{ id: string; description: string; truncated: boolean }> = [];
  const encode = () => JSON.stringify({ inputs: selected, conversations: candidates, summariesMayBeTruncated: true });
  for (const input of inputs.slice(0, policy.batchSize)) {
    const full = inputPrinter.describe(input);
    const item = { id: input.metadata.name, description: full.slice(0, 8000), truncated: full.length > 8000 };
    selected.push(item);
    if (encode().length <= policy.contextChars) continue;
    if (selected.length > 1) { selected.pop(); break; }
    while (encode().length > policy.contextChars && item.description.length > 256) {
      item.description = item.description.slice(0, Math.floor(item.description.length / 2)); item.truncated = true;
    }
    if (encode().length > policy.contextChars) throw new Error("Route Input identity exceeds contextChars");
  }
  return { inputIds: selected.map(i => i.id), candidates, prompt: encode() };
}
