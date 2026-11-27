import type { Background as AgentBackground } from "../../../agents/background.ts";
import type { Store } from "../work/store.ts";
import { backgroundText, routeParts } from "../background.ts";

/** Current Route background, captured before one model request. */
export class Background implements AgentBackground {
  readonly messages;
  private readonly parts: Record<string, string>;

  constructor(store: Store) {
    this.parts = routeParts(store);
    this.messages = [{ customType: "aide.topic-directory", details: { scope: "roots" }, content: this.text() }];
  }

  text(): string { return backgroundText(this.parts); }
}
