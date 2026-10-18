import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { INPUT_TYPE, type Conversation, type ConversationMessage, type InputSpec, type InputStatus, type Resource } from "@compforge/aide-plugin";

const MessageSchema = z.object({ id: z.string(), conversationId: z.string(), at: z.string(),
  role: z.enum(["user", "aide"]), text: z.string(), workId: z.string().nullable() });
const SpecSchema = z.object({ conversationId: z.string().min(1).max(200), origin: z.enum(["channel", "source"]),
  text: z.string().min(1).max(32_000), timezone: z.string().optional(), replyTo: z.string().optional(),
  observation: z.record(z.string(), z.unknown()).optional() });
const StatusSchema = z.object({ phase: z.enum(["running", "waiting", "done", "failed"]).optional(),
  laneId: z.string().optional(), error: z.string().optional(), quietReason: z.string().optional(),
  question: z.object({ kind: z.enum(["ask", "confirm"]), title: z.string(), prompt: z.string(),
    choices: z.array(z.object({ value: z.string(), label: z.string() })).optional() }).nullable().optional(),
}).strict();
const StoredInputSchema = z.object({ id: z.string(), createdAt: z.string(), revision: z.number().int(),
  spec: SpecSchema.omit({ text: true }),
  content: z.discriminatedUnion("kind", [z.object({ kind: z.literal("message"), messageId: z.string() }),
    z.object({ kind: z.literal("observation"), text: z.string() })]),
  status: StatusSchema, messageIds: z.array(z.string()),
});
const StateSchema = z.object({ conversations: z.array(z.object({ id: z.string(), createdAt: z.string(), revision: z.number().int(),
  inputs: z.array(StoredInputSchema), messages: z.array(MessageSchema),
  receipts: z.array(z.object({ key: z.string(), responseId: z.string() })),
})) });
type State = z.infer<typeof StateSchema>;
type StoredConversation = State["conversations"][number];
type StoredInput = z.infer<typeof StoredInputSchema>;
export const conversationKey = (id: string) => createHash("sha256").update(id).digest("hex");

/**
 * @spec Input state and its messages commit atomically; a Channel input references one stored user Message.
 * @why Session's single-host lease owns writes. Plugins access projections over IPC, never these files.
 * @see {@link ../../../docs/chief.md}
 */
export class ConversationStore {
  private readonly path: string;
  private state: State;
  private readonly listeners = new Set<(conversation: Conversation) => void>();

  constructor(session: { dir: string }) {
    this.path = join(session.dir, "conversations.json");
    this.state = existsSync(this.path) ? StateSchema.parse(JSON.parse(readFileSync(this.path, "utf8"))) : { conversations: [] };
  }

  list(): Conversation[] { return this.state.conversations.map((item) => this.project(item)); }
  get(id: string): Conversation | undefined {
    const item = this.state.conversations.find((item) => item.id === id);
    return item ? this.project(item) : undefined;
  }
  subscribe(listener: (conversation: Conversation) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }

  inputs(conversationId?: string): Resource<InputSpec, InputStatus>[] {
    return this.state.conversations.filter((item) => conversationId === undefined || item.id === conversationId)
      .flatMap((conversation) => conversation.inputs.map((input) => this.inputResource(conversation, input)));
  }
  input(id: string): Resource<InputSpec, InputStatus> | undefined { return this.inputs().find((item) => item.metadata.name === id); }

  submit(id: string, raw: InputSpec, status: InputStatus = {}): Resource<InputSpec, InputStatus> {
    const spec = SpecSchema.parse(raw);
    const previous = this.input(id);
    if (previous) {
      if (previous.spec.conversationId !== spec.conversationId) throw new Error("Input identity belongs to another conversation");
      return previous;
    }
    this.change(spec.conversationId, (conversation) => {
      const { text, ...storedSpec } = spec;
      const { messages = [], ...state } = status;
      const inbound = spec.origin === "channel" ? messages.find((item) => item.role === "user") ?? {
        id: randomUUID(), conversationId: spec.conversationId, at: new Date().toISOString(), role: "user" as const, text, workId: null,
      } : undefined;
      const delivered = inbound ? [inbound, ...messages.filter((item) => item.id !== inbound.id)] : messages;
      this.append(conversation, delivered);
      conversation.inputs.push({ id, createdAt: new Date().toISOString(), revision: 1, spec: storedSpec,
        content: inbound ? { kind: "message", messageId: inbound.id } : { kind: "observation", text },
        status: StatusSchema.parse(state), messageIds: delivered.map((item) => item.id) });
    });
    return this.input(id)!;
  }

  update(resource: Resource<InputSpec, InputStatus>, patch: Partial<InputStatus>): Resource<InputSpec, InputStatus> {
    const current = this.input(resource.metadata.name);
    if (!current || current.metadata.uid !== resource.metadata.uid || current.metadata.resourceVersion !== resource.metadata.resourceVersion) {
      throw new Error("Input resource version conflict; read it again");
    }
    this.change(current.spec.conversationId, (conversation) => {
      const input = conversation.inputs.find((item) => item.id === resource.metadata.name)!;
      const { messages, ...status } = patch;
      const next = StatusSchema.parse({ ...input.status, ...status });
      if ((input.status.phase === "done" || input.status.phase === "failed") && next.phase !== "done" && next.phase !== "failed") {
        throw new Error("Completed input cannot be replayed");
      }
      if (next.phase === "running" && conversation.inputs.some((other) => other.id !== input.id
        && (other.status.phase === "running" || other.status.phase === "waiting"))) throw new Error("Conversation already has an active input");
      if (messages) {
        this.append(conversation, messages);
        input.messageIds = [...new Set([...input.messageIds, ...messages.map((item) => item.id)])];
      }
      input.status = next; input.revision++;
    });
    return this.input(resource.metadata.name)!;
  }

  archive(conversationId: string, messages: ConversationMessage[], receipts: Array<{ key: string; responseId: string }> = []): void {
    this.change(conversationId, (conversation) => {
      this.append(conversation, messages);
      conversation.receipts = [...new Map([...conversation.receipts, ...receipts].map((item) => [item.key, item])).values()];
    });
  }
  response(key: string): ConversationMessage | undefined {
    for (const item of this.state.conversations) {
      const receipt = item.receipts.find((entry) => entry.key === key);
      if (receipt) return structuredClone(item.messages.find((message) => message.id === receipt.responseId));
    }
    return undefined;
  }

  private project(item: StoredConversation): Conversation {
    return structuredClone({ id: item.id, revision: item.revision, createdAt: item.createdAt,
      pendingInputIds: item.inputs.filter((input) => !input.status.phase).map((input) => input.id), messages: item.messages });
  }
  private inputResource(conversation: StoredConversation, input: StoredInput): Resource<InputSpec, InputStatus> {
    const text = input.content.kind === "message"
      ? conversation.messages.find((message) => input.content.kind === "message" && message.id === input.content.messageId)!.text : input.content.text;
    return structuredClone({ ...INPUT_TYPE, metadata: { name: input.id, namespace: "aide-system", uid: `input:${input.id}`,
      generation: 1, resourceVersion: String(input.revision), creationTimestamp: input.createdAt,
      labels: { conversation: conversationKey(conversation.id) } }, spec: { ...input.spec, text },
      status: { ...input.status, messages: conversation.messages.filter((message) => input.messageIds.includes(message.id)) } });
  }
  private append(conversation: StoredConversation, messages: ConversationMessage[]): void {
    for (const raw of messages) {
      const message = MessageSchema.parse(raw);
      if (message.conversationId !== conversation.id) throw new Error("Message belongs to another conversation");
      const existing = conversation.messages.find((item) => item.id === message.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(message)) throw new Error("Message identity already exists with different content");
      if (!existing) conversation.messages.push(message);
    }
  }
  private change(id: string, action: (conversation: StoredConversation) => void): void {
    const next = structuredClone(this.state);
    let conversation = next.conversations.find((item) => item.id === id);
    if (!conversation) { conversation = { id, revision: 0, createdAt: new Date().toISOString(), inputs: [], messages: [], receipts: [] }; next.conversations.push(conversation); }
    action(conversation); conversation.revision++;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 }); renameSync(temporary, this.path); this.state = next;
    const projected = this.project(conversation);
    for (const listener of this.listeners) listener(projected);
  }
}
