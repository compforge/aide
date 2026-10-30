import { createHash } from "node:crypto";
import type { Logger } from "pino";
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
 * @spec A non-idempotent comment is attempted once. Interrupted sending becomes uncertain, never an automatic resend.
 * @spec Preflight failures can retry; a saved Output and provider scope fix the destination before any write.
 * @spec Correlation receipts survive Output reclamation within the Host's configured dedup window.
 * @link docs/connector/requirements.md
 */
export class RequirementOutputDelivery {
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private running?: Promise<void>;
  private stopped = false;
  constructor(private readonly store: OutputStore, private readonly connectors: Writer, private readonly log: Logger) {}
  start() {
    this.unsubscribe = this.store.subscribe(() => this.schedule());
    this.timer = setInterval(() => this.schedule(), 1000); this.timer.unref();
    this.schedule();
  }
  private schedule() { void this.flush().catch((err) => this.log.error({ err }, "Requirement Output delivery scan failed")); }
  flush(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.running ??= this.run().finally(() => { this.running = undefined; });
  }
  private async run() {
    for (let output of this.store.list()) {
      if (this.stopped) return;
      const target = output.status.delivery?.target;
      if (!target || !output.status.disclosure) continue;
      if (!isRequirementAddress(target)) continue;
      const id = output.metadata.name;
      if (output.status.phase === "sending") {
        this.store.uncertain(id, "Comment delivery was interrupted; reconcile provider receipt before retrying");
        this.log.warn({ outputId: id }, "Interrupted requirement delivery requires verification");
        continue;
      }
      if (output.status.phase !== "pending" || (output.status.nextAttemptAt && Date.parse(output.status.nextAttemptAt) > Date.now())) continue;
      try {
        const account = await this.connectors.requirements.identity(target.source);
        if (account.scope !== target.scope) {
          this.store.uncertain(id, "Connector project changed; saved destination is preserved");
          this.log.warn({ outputId: id, connector: target.source }, "Requirement Output project no longer matches connector");
          continue;
        }
      } catch (err) {
        this.store.retry(id, String(err), new Date(Date.now() + 30_000).toISOString());
        this.log.warn({ err, outputId: id }, "Requirement Output preflight failed; retry scheduled");
        continue;
      }
      output = await this.store.prepare(id);
      if (!output.status.delivery || !sameAddress(output.status.delivery.target, target) || output.status.phase !== "pending") continue;
      this.store.storage.transaction(() => {
        this.store.storage.addReceipt(deliveryKey(id), JSON.stringify({ target, hash: hash(output.status.delivery!.text) }));
        this.store.begin(id);
      });
      try {
        const external = await this.connectors.addRequirementComment(target, { text: output.status.delivery!.text, deliveryId: id });
        receipt(this.store, id, target, output.status.delivery!.text, external);
        this.log.info({ outputId: id, commentId: external.id, connector: target.source }, "Requirement comment delivered");
      } catch (err) {
        this.store.uncertain(id, String(err));
        this.log.warn({ err, outputId: id, connector: target.source }, "Requirement comment delivery uncertain; automatic resend stopped");
      }
    }
  }
  async close() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    await this.running;
  }
}
