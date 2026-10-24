import type { Background as AgentBackground } from "../../../agents/background.ts";
import type { Store } from "../store.ts";
import { backgroundText, topicParts } from "../background.ts";
import type { TopicResource } from "./model.ts";

/** Current Topic background, captured before one model request. */
export class Background implements AgentBackground {
  private readonly parts: Record<string, string>;

  constructor(store: Store, topic: TopicResource | undefined, topicId: string) {
    this.parts = topicParts(store, topic, topicId);
  }

  text(): string { return backgroundText(this.parts); }
}
