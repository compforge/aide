import type { Background as AgentBackground } from "../../../agents/background.ts";
import type { Store } from "../store.ts";
import { backgroundText, workParts } from "../background.ts";
import type { TaskResource } from "./model.ts";

/** Current Task background, captured before one model request. */
export class Background implements AgentBackground {
  private readonly parts: Record<string, string>;

  constructor(store: Store, resource: TaskResource) {
    this.parts = workParts(store, resource);
  }

  text(): string { return backgroundText(this.parts); }
}
