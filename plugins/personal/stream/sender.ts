import { agentStreamKinds, type AgentStreamEvent } from "../../../src/stream/agent.ts";
import { MailWriter, type NoteCitation } from "./writer.ts";
import type { Logger } from "pino";
import type { StreamRef } from "@compforge/aide-plugin";
import { type AnyEventEnvelope } from "../../../src/host/event/index.ts";
import type { ExecutionService } from "../../../src/host/runtime/execution.ts";
import { InputAttention, inputAttention } from "../input/model.ts";
import type { InputStore } from "../input/store.ts";
import type { TopicStore } from "../topic/store.ts";
import type { OutputStore } from "../output/store.ts";

interface Writer {
  outputId: string; stream: StreamRef; chunks: AgentStreamEvent[];
  timer?: ReturnType<typeof setTimeout>; error?: string;
}
/** @spec Only an admitted Immediate Channel reply starts automatically; background work stays silent.
 * @spec A writer keeps its original Input/address binding when another Input steers the same invocation.
 * @spec Harness events preserve message upserts, clears and tool updates in their original order.
 * @link docs/personal/output.md
 */
export class MailSender {
  private readonly writers = new Map<string, Writer>();
  private readonly unsubscribe: () => void;
  constructor(private readonly outputs: OutputStore, private readonly topics: TopicStore, private readonly inputs: InputStore,
    private readonly executions: ExecutionService, private readonly log: Logger) {
    this.unsubscribe = executions.subscribeEvents(event => this.observe(event));
  }
  async begin(topicId: string, executionId: string, inputIds: string[]): Promise<boolean> {
    if (this.writers.has(executionId)) return true;
    const candidates = inputIds.map(id => this.inputs.get(id)).filter(i => i?.spec.origin === "channel" && inputAttention(i.spec) === InputAttention.Immediate);
    const input = candidates[0];
    if (!input?.spec.source || candidates.some(i => i!.spec.source?.uid !== input.spec.source!.uid)) return false;
    const receipt = await this.topics.say(topicId, input.metadata.name, "", executionId,
      { idempotencyKey: `stream:${executionId}`, respondToInputId: input.metadata.name, inputIds, contentKind: "agent" });
    const output = this.outputs.get(receipt.outputId)!;
    if (this.outputs.streams.get(output.spec.stream).status.phase !== "open") return false;
    this.writers.set(executionId, { outputId: receipt.outputId, stream: output.spec.stream, chunks: [] });
    this.log.info({ outputId: receipt.outputId, streamUid: output.spec.stream.uid, executionId }, "Chief output stream opened");
    return true;
  }
  cite(executionId: string, notes: readonly NoteCitation[]) {
    const writer = this.writers.get(executionId);
    if (!writer || writer.error) throw new Error("No writable live Stream for this execution");
    new MailWriter(this.outputs.streams, writer.stream).cite(notes);
    return { stream: writer.stream };
  }
  finish(executionId: string, error?: string): void {
    const writer = this.writers.get(executionId);
    if (!writer) return;
    try {
      if (writer.error) throw new Error(writer.error);
      this.flush(writer);
      if (error) this.outputs.streams.interrupt(writer.stream, error);
      else this.outputs.streams.complete(writer.stream);
      this.log.info({ outputId: writer.outputId, streamUid: writer.stream.uid, error }, "Chief output stream closed");
    } catch (cause) {
      this.fail(writer, cause);
      throw cause;
    } finally { clearTimeout(writer.timer); this.writers.delete(executionId); }
  }
  recover(): void {
    for (const output of this.outputs.list()) {
      if (output.metadata.deletionTimestamp) continue;
      if (this.outputs.streams.get(output.spec.stream).status.phase === "open") this.outputs.streams.interrupt(output.spec.stream, "Generating execution was interrupted by Host restart");
    }
  }
  private observe(event: AnyEventEnvelope) {
    if (!event.invocationId) return;
    const invocation = this.executions.listHarnessInvocations().find(i => i.invocationId === event.invocationId);
    const writer = invocation && this.writers.get(invocation.executionId);
    if (!writer || writer.error) return;
    if (!(agentStreamKinds as readonly string[]).includes(event.kind)) return;
    writer.chunks.push({ kind: event.kind, payload: event.payload } as AgentStreamEvent);
    writer.timer ??= setTimeout(() => {
      try { this.flush(writer); }
      catch (error) { this.fail(writer, error); }
    }, 150);
  }
  private fail(writer: Writer, error: unknown) {
    clearTimeout(writer.timer); writer.timer = undefined; writer.chunks = [];
    writer.error = "Chief stream could not be persisted";
    this.log.error({ err: error, outputId: writer.outputId, streamUid: writer.stream.uid }, writer.error);
    try {
      if (this.outputs.streams.get(writer.stream).status.phase === "open") this.outputs.streams.interrupt(writer.stream, writer.error);
    } catch (cause) {
      this.log.error({ err: cause, outputId: writer.outputId }, "Could not close interrupted Stream");
    }
  }
  private flush(writer: Writer) {
    clearTimeout(writer.timer); writer.timer = undefined;
    if (writer.chunks.length) { this.outputs.streams.append(writer.stream, writer.chunks); writer.chunks = []; }
  }
  close() {
    this.unsubscribe();
    for (const executionId of this.writers.keys()) {
      try { this.finish(executionId, "Host is stopping"); }
      catch (error) { this.log.warn({ err: error, executionId }, "Stream owner already unavailable during shutdown"); }
    }
  }
}
