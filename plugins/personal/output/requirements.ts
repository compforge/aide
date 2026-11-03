import { readAgentStream } from "../../../src/stream/agent.ts";
import { DeliveryError } from "@compforge/aide-connector";
import type { OutputTransportResolver } from "./delivery.ts";
import { createHash } from "node:crypto";
import type { ConnectorClient, RequirementAddress, RequirementComment, RequirementIdentity } from "@compforge/aide-plugin";
import { isRequirementAddress, requirementAddress } from "../../../connectors/requirements/address.ts";
import { OutputStore } from "./store.ts";
import { sameAddress } from "../../../src/address.ts";

interface Writer {
  requirements: ConnectorClient["requirements"];
  addRequirementComment(identity: RequirementIdentity, comment: { text: string; deliveryId: string }): Promise<{ id: string; scope: string }>;
}
const hash = (text: string) => createHash("sha256").update(text.trimEnd()).digest("hex");
const commentKey = (target: RequirementAddress, id: string) => `requirement-comment:${hash(JSON.stringify([target.scope, target.category, target.id, id]))}`;
const deliveryKey = (id: string) => `requirement-delivery:${id}`;

function receipt(store: OutputStore, outputId: string, target: RequirementAddress, text: string, external: { id: string; scope: string }) {
  if (external.scope !== target.scope) throw new Error("Comment receipt belongs to a different project");
  store.storage.transaction(() => {
    store.storage.addReceipt(commentKey(target, external.id), JSON.stringify({ hash: hash(text), outputId }));
    if (store.get(outputId)) store.delivered(outputId, external);
  });
}
/** @spec Receipt matching is scoped to the work item and exact content; sharing the CLI account does not make a comment Aide's. */
function ownComment(store: OutputStore, target: RequirementAddress, comment: RequirementComment): boolean {
  const known = store.storage.receipt(commentKey(target, comment.id));
  if (known && JSON.parse(known).hash === hash(comment.text)) return true;
  if (!comment.deliveryId) return false;
  const value = store.storage.receipt(deliveryKey(comment.deliveryId));
  if (!value) return false;
  const saved = JSON.parse(value) as { target: RequirementAddress; hash: string };
  if (!sameAddress(saved.target, target) || saved.hash !== hash(comment.text)) return false;
  receipt(store, comment.deliveryId, target, comment.text, { id: comment.id, scope: target.scope });
  return true;
}
export function requirementOutputs(requirements: ConnectorClient["requirements"], store: OutputStore): ConnectorClient["requirements"] {
  return { ...requirements, async comments(identity, query) {
    const page = await requirements.comments(identity, query);
    const account = await requirements.identity(identity.source);
    const target = requirementAddress(identity, account.scope);
    return { ...page, items: page.items.map((comment) => ({ ...comment, ownOutput: ownComment(store, target, comment) })) };
  } };
}

/**
 * @spec Non-idempotent comments retry only explicit pre-effect rejection. Interrupted sending becomes uncertain.
 * @spec Preflight failures can retry; a saved Output and provider scope fix the destination before any write.
 * @spec Correlation receipts survive Output reclamation within the Host's configured dedup window.
 * @link docs/connector/requirements.md
 */
export function requirementTransport(store: OutputStore, connectors: Writer): OutputTransportResolver {
  return async target => {
    if (!isRequirementAddress(target)) return;
    const account = await connectors.requirements.identity(target.source);
    if (account.scope !== target.scope) throw new DeliveryError({ kind: "permanent", code: "project_changed", message: "Connector project changed; cannot prepare the saved destination" });
    return { replay: "once", async send(message) {
      const text = readAgentStream(message.stream).text;
      if (!text.trim()) return undefined;
      store.storage.addReceipt(deliveryKey(message.id), JSON.stringify({ target, hash: hash(text) }));
      const external = await connectors.addRequirementComment(target, { text: text, deliveryId: message.id });
      if (external.scope !== target.scope) throw new Error("Comment receipt belongs to a different project");
      store.storage.addReceipt(commentKey(target, external.id), JSON.stringify({ hash: hash(text), outputId: message.id }));
      return external;
    } };
  };
}
