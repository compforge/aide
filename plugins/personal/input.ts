import type { PluginContext, InputSpec, InputStatus, Resource } from "@compforge/aide-plugin";
import { INPUT_TYPE, digest } from "./chief-model.ts";
import { CONVERSATION_TYPE, initialConversationName, type ConversationSpec, type ConversationStatus, type ConversationResource } from "./conversation/model.ts";
import { appendConversationInput } from "./conversation/input.ts";

type Input = Readonly<Resource<InputSpec, InputStatus>>;
type Creation = NonNullable<NonNullable<InputStatus["routing"]>["creation"]>;

export function registerInputRouting(context: PluginContext): void {
  context.controllers.register<InputSpec, InputStatus>({ resourceType: INPUT_TYPE, maxConcurrency: 1,
    reconcile: (_execution, input) => reconcileInput(context, input),
  });
}

/**
 * @spec With no Conversations, create one, append the Input and finish routing.
 * @spec Otherwise append to Default first, then rule-created and rule-related Conversations as each is known.
 * @spec Retry creation by stable identity and each append by Input ID; never wait for a complete destination plan.
 * @case tests/input-routing.test.ts
 * @link docs/plugin/personal.md
 */
export async function reconcileInput(context: Pick<PluginContext, "resources" | "logger">, original: Input): Promise<void> {
  const ref = { ...INPUT_TYPE, ...original.metadata };
  const current = await context.resources.get<InputSpec, InputStatus>(ref);
  if (!current || ["done", "ignored"].includes(current.status.routing?.phase ?? "")) return;
  let input: Input = current;
  const conversations = (await context.resources.list<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE, { sessionId: "*" }))
    .filter((c) => !c.metadata.deletionTimestamp);
  if (!input.status.routing) input = await context.resources.patchStatus(input, { routing: {
    phase: "running", bootstrap: !conversations.length, reason: conversations.length ? "Default and deterministic rules" : "First Conversation",
  } });
  let attached = conversations.some((c) => c.spec.inputIds.includes(input.metadata.name));
  const append = async (c: Readonly<ConversationResource>) => {
    if (await appendConversationInput(context.resources, { sessionId: c.spec.sessionId, name: c.metadata.name, uid: c.metadata.uid }, input)) {
      context.logger.info("Chief input attached to conversation", { attributes: { inputId: input.metadata.name,
        conversationId: c.spec.id, sessionId: c.spec.sessionId } });
    }
    attached = true;
  };
  const create = async () => {
    if (!input.status.routing!.creation) {
      const sessionId = input.spec.sessionId ?? `conversation:${digest(["input", input.metadata.name])}`;
      input = await context.resources.patchStatus(input, { routing: { ...input.status.routing!, creation: { sessionId, name: digest(sessionId) } } });
    }
    const planned = input.status.routing!.creation!;
    const c = await createConversation(context, input, planned);
    if (!planned.uid) input = await context.resources.patchStatus(input, { routing: { ...input.status.routing!, creation: { ...planned, uid: c.metadata.uid } } });
    await append(c);
  };
  const finish = async () => {
    input = await context.resources.patchStatus(input, { routing: { ...input.status.routing!, phase: attached ? "done" : "ignored",
      reason: attached ? input.status.routing!.reason : "No default or deterministic destination" } });
    context.logger.info("Chief input routing completed", { attributes: { inputId: input.metadata.name, phase: input.status.routing!.phase,
      reason: input.status.routing!.reason } });
  };
  if (input.status.routing!.bootstrap) {
    await create();
    await finish();
    return;
  }
  const defaultConversation = conversations.find((c) => c.spec.default);
  if (defaultConversation) await append(defaultConversation);
  if (input.status.routing!.creation || (input.spec.sessionId && !conversations.some((c) => c.spec.sessionId === input.spec.sessionId))) await create();
  for (const c of conversations) {
    if (input.spec.sessionId && c.spec.sessionId === input.spec.sessionId) await append(c);
  }
  const originalInputId = input.spec.observation?.originalInputId;
  if (typeof originalInputId === "string" && originalInputId !== input.metadata.name) {
    const preceding = await context.resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "aide-system", name: originalInputId });
    if (preceding && !["done", "ignored"].includes(preceding.status.routing?.phase ?? "")) {
      throw new Error(`Original Input routing is pending: ${originalInputId}`);
    }
    for (const c of conversations) {
      if (c.spec.inputIds.includes(originalInputId)) await append(c);
    }
  }
  await finish();
}

/** @spec Pin the created incarnation before append; retries never recreate a deleted, pinned Conversation. */
async function createConversation(context: Pick<PluginContext, "resources" | "logger">, input: Input, planned: Creation): Promise<Readonly<ConversationResource>> {
  const ref = { ...CONVERSATION_TYPE, ...planned, namespace: "v1" as const };
  if (planned.uid) {
    const c = await context.resources.get<ConversationSpec, ConversationStatus>(ref);
    if (!c || c.metadata.deletionTimestamp) throw new Error(`Created Conversation no longer exists: ${planned.sessionId}/${planned.name}`);
    return c;
  }
  try {
    const c = await context.resources.create<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE, {
      sessionId: planned.sessionId, name: planned.name,
      spec: { id: planned.sessionId, sessionId: planned.sessionId, name: initialConversationName(input.spec.text), inputIds: [] },
      status: { processing: {}, messages: [], receipts: [] },
    });
    context.logger.info("Chief routing created conversation", { attributes: { inputId: input.metadata.name,
      conversationId: c.spec.id, sessionId: planned.sessionId } });
    return c;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("resource already exists")) throw error;
    const existing = await context.resources.get<ConversationSpec, ConversationStatus>(ref);
    if (!existing || existing.metadata.deletionTimestamp || existing.spec.id !== planned.sessionId || existing.spec.sessionId !== planned.sessionId) {
      throw new Error(`Created Conversation identity is unavailable: ${planned.sessionId}/${planned.name}`);
    }
    return existing;
  }
}
