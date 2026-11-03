import type { Background as AgentBackground } from "../../../agents/background.ts";
import type { Store } from "../store.ts";
import { backgroundText, topicParts } from "../background.ts";
import type { TopicResource } from "./model.ts";

/** Current Topic background, captured before one model request. */
export class Background implements AgentBackground {
  private readonly parts: Record<string, string>;

  constructor(store: Store, topic: TopicResource | undefined, topicId: string) {
    this.parts = topicParts(store, topic, topicId);
    if (topic?.status.execution) this.parts.assessments = JSON.stringify({
      pendingInputIds: store.topics.inputStore.query("assessExecution", topic.status.execution.id).map(i => i.metadata.name).sort(),
      instruction: "Call assess_input separately for every admitted Input before ending, including duplicate observations. A new Input does not replace earlier obligations. Do not repeat external actions to acknowledge them.",
    });
  }

  text(): string { return backgroundText(this.parts); }
}
