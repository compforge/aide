import { snapshotMessage } from "../messages.ts";
import type { Background as AgentBackground } from "../../../agents/background.ts";
import type { Store } from "../work/store.ts";
import { backgroundText, workParts } from "../background.ts";
import type { TaskResource } from "./model.ts";

/** Current Task background, captured before one model request. */
export class Background implements AgentBackground {
  readonly messages;
  private readonly parts: Record<string, string>;

  constructor(store: Store, resource: TaskResource) {
    const { objective, ...topic } = workParts(store, resource);
    this.parts = { ...topic, objective };
    this.messages = [
      snapshotMessage({ kind: "topic", uid: resource.status.topic.uid }, backgroundText(topic)),
      snapshotMessage({ kind: "task", uid: resource.metadata.uid, version: resource.metadata.resourceVersion }, backgroundText({ objective })),
    ];
  }

  text(): string { return backgroundText(this.parts); }
}
