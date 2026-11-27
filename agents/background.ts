import type { ApplicationMessage } from "@compforge/aide-plugin";

export type BackgroundPart = ApplicationMessage & { content: string };
/**
 * @spec Background is the current business snapshot for one agent request, rendered as custom/user material.
 * @spec The factory reads current resources; text() only renders its snapshot, without fetching or persisting state.
 * @link docs/harness/pi.md#当前业务背景
 */
export interface Background {
  text(): string;
  readonly messages?: readonly BackgroundPart[];
}

export type ReadBackground = () => Background | Promise<Background>;

export function backgroundParts(value: Background): readonly BackgroundPart[] {
  return value.messages ?? [{ customType: "aide.background", details: {}, content: value.text() }];
}

export function messageBackground(messages: readonly BackgroundPart[]): Background {
  return { messages, text: () => messages.map(m => m.content).filter(Boolean).join("\n\n") };
}

export function withIdentity(current: Background | undefined, identity: string): Background {
  return messageBackground([...(current ? backgroundParts(current) : []),
    ...(identity ? [{ customType: "aide.background", details: {}, content: identity }] : [])]);
}
