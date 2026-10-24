import type { Background as AgentBackground } from "../../../agents/background.ts";
import type { Store } from "../store.ts";
import { backgroundText, routeParts } from "../background.ts";

/** Current Route background, captured before one model request. */
export class Background implements AgentBackground {
  private readonly parts: Record<string, string>;

  constructor(store: Store) {
    this.parts = routeParts(store);
  }

  text(): string { return backgroundText(this.parts); }
}
