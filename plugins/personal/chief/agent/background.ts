import { snapshotMessage } from "../../messages.ts";
import type { Background as AgentBackground } from "../../../../agents/background.ts";
import type { Store } from "../../work/store.ts";
import { backgroundText, topicParts } from "../../background.ts";
import type { TopicResource } from "../../topic/model.ts";

/** Current Topic background, captured before one model request. */
export class Background implements AgentBackground {
  readonly messages;
  private readonly parts: Record<string, string>;

  constructor(store: Store, topic: TopicResource | undefined, topicId: string) {
    this.parts = topicParts(store, topic, topicId);
    this.messages = topic ? [snapshotMessage({ kind: "topic", uid: topic.metadata.uid }, this.text())] : undefined;
  }

  text(): string { return backgroundText(this.parts); }
}
