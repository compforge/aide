import type { Background as AgentBackground } from "../../../agents/background.ts";
import type { Store } from "../store.ts";
import { backgroundText, workParts } from "../background.ts";
import type { RoutineResource } from "./model.ts";

/** Current Routine background, captured before one model request. */
export class Background implements AgentBackground {
  private readonly parts: Record<string, string>;

  constructor(store: Store, resource: RoutineResource) {
    this.parts = workParts(store, resource);
  }

  text(): string { return backgroundText(this.parts); }
}
