import type { Background as AgentBackground } from "../../../agents/background.ts";
import type { Store } from "../store.ts";
import { backgroundText, conversationParts } from "../background.ts";
import type { ConversationResource } from "./model.ts";

/** Current Conversation background, captured before one model request. */
export class Background implements AgentBackground {
  private readonly parts: Record<string, string>;

  constructor(store: Store, conversation: ConversationResource | undefined, conversationId: string) {
    this.parts = conversationParts(store, conversation, conversationId);
  }

  text(): string { return backgroundText(this.parts); }
}
