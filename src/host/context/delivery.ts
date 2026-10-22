import { newId } from "../event/ids.ts";
import type {
  AnyEventEnvelope,
  EventDraft,
  EventEnvelope,
} from "../event/index.ts";

/** History belongs to one resource/controller context; Target is carried by the envelope. */
export type ContextSource = {
  kind: "context_history";
  key: "history";
  owner: { type: "execution_context"; contextId: string };
};
export function executionHistorySource(contextId: string): ContextSource {
  return { kind: "context_history", key: "history", owner: { type: "execution_context", contextId } };
}

/** 一次实际组装出的 source 内容；范围是 `(afterSeq, throughSeq]`。 */
export interface ContextSnapshot {
  snapshotId: string;
  source: ContextSource;
  afterSeq: number;
  throughSeq: number;
  text: string;
}

export type ContextDeliveryTransport =
  | "sync_context"
  | "submit_side_channel"
  | "prompt_prepend";

/**
 * accepted 只表示对应 transport 已接受这份 snapshot，不声称 model 已读取或采用。
 * 目标 Harness / Target / Session 和当前 Turn 使用 Event envelope 的执行坐标。
 */
export interface ContextDeliveryReceipt {
  snapshotId: string;
  contextEpochId: string;
  transport: ContextDeliveryTransport;
  accepted: true;
}

/** ContextEpoch 不单独落可变快照；它由同一 epoch 的 DeliveryReceipt 重放得到。 */
export interface ContextEpoch {
  contextEpochId: string;
  throughSeq: number;
  snapshotId: string;
  receiptEventId: string;
}

export type ContextSnapshotEnvelope = EventEnvelope<"_aide_context_snapshot">;
type ReceiptEnvelope = EventEnvelope<"_aide_context_delivery_receipt">;
type ContextDeliveryDraft =
  | EventDraft<"_aide_context_snapshot">
  | EventDraft<"_aide_context_delivery_receipt">;
type ContextDeliveryEnvelope = ContextSnapshotEnvelope | ReceiptEnvelope;

/**
 * Context delivery 的重放索引。Snapshot 说明“准备送什么”，Receipt 才能推进
 * HarnessSession 的 ContextEpoch；只有 snapshot、没有 receipt 时，下次仍会重投。
 */
export class ContextDeliveryLedger {
  private readonly snapshots = new Map<string, ContextSnapshotEnvelope>();
  private readonly epochs = new Map<string, ContextEpoch>();

  constructor(events: Iterable<AnyEventEnvelope> = []) {
    for (const event of events) this.apply(event);
  }

  snapshot(snapshotId: string): ContextSnapshotEnvelope | undefined {
    return this.snapshots.get(snapshotId);
  }

  epoch(contextEpochId: string): ContextEpoch | undefined {
    return this.epochs.get(contextEpochId);
  }

  apply(event: AnyEventEnvelope): ContextDeliveryEnvelope | undefined {
    if (event.kind === "_aide_context_snapshot") {
      const snapshot = event.payload;
      if (snapshot.afterSeq > snapshot.throughSeq) {
        throw new Error(
          `context snapshot ${snapshot.snapshotId} has invalid range ${snapshot.afterSeq}..${snapshot.throughSeq}`,
        );
      }
      // Historical snapshots retain their original owner; replay must not rewrite provenance.
      if (!this.snapshots.has(snapshot.snapshotId)) {
        this.snapshots.set(snapshot.snapshotId, event);
      }
      return event;
    }

    if (event.kind !== "_aide_context_delivery_receipt") return undefined;
    const receipt = event.payload;
    const snapshot = this.snapshots.get(receipt.snapshotId);
    if (!snapshot) {
      throw new Error(
        `context receipt for ${receipt.snapshotId} appeared before its snapshot`,
      );
    }
    const current = this.epochs.get(receipt.contextEpochId);
    if (!current || snapshot.payload.throughSeq >= current.throughSeq) {
      this.epochs.set(receipt.contextEpochId, {
        contextEpochId: receipt.contextEpochId,
        throughSeq: snapshot.payload.throughSeq,
        snapshotId: receipt.snapshotId,
        receiptEventId: event.eventId,
      });
    }
    return event;
  }
}

export type ContextDeliveryAppender<TContext> = (
  context: TContext,
  draft: ContextDeliveryDraft,
) => AnyEventEnvelope;

/** Controller 使用的持久化入口：总是先 append 正典事件，再更新内存重放索引。 */
export class ContextDeliveries<TContext> {
  private readonly ledger: ContextDeliveryLedger;

  constructor(
    private readonly append: ContextDeliveryAppender<TContext>,
    events: Iterable<AnyEventEnvelope> = [],
  ) {
    this.ledger = new ContextDeliveryLedger(events);
  }

  epoch(contextEpochId: string): ContextEpoch | undefined {
    return this.ledger.epoch(contextEpochId);
  }

  prepare(
    context: TContext,
    opts: {
      invocationId: string;
      harnessSessionId?: string;
      source: ContextSource;
      afterSeq: number;
      throughSeq: number;
      text: string;
    },
  ): ContextSnapshotEnvelope {
    const event = this.append(context, {
      kind: "_aide_context_snapshot",
      harnessSessionId: opts.harnessSessionId,
      invocationId: opts.invocationId,
      payload: {
        snapshotId: newId("ctx"),
        source: opts.source,
        afterSeq: opts.afterSeq,
        throughSeq: opts.throughSeq,
        text: opts.text,
      },
    }) as ContextSnapshotEnvelope;
    this.ledger.apply(event);
    return event;
  }

  accept(
    context: TContext,
    snapshot: ContextSnapshotEnvelope,
    opts: {
      contextEpochId: string;
      harnessSessionId?: string;
      transport: ContextDeliveryTransport;
    },
  ): ReceiptEnvelope {
    const event = this.append(context, {
      kind: "_aide_context_delivery_receipt",
      parentEventId: snapshot.eventId,
      harnessSessionId: opts.harnessSessionId,
      invocationId: snapshot.invocationId,
      payload: {
        snapshotId: snapshot.payload.snapshotId,
        contextEpochId: opts.contextEpochId,
        transport: opts.transport,
        accepted: true,
      },
    }) as ReceiptEnvelope;
    this.ledger.apply(event);
    return event;
  }
}
