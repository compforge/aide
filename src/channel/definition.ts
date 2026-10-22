import type { InputReceipt } from "../../plugins/personal/input/model.ts";
import type { Incoming } from "./message.ts";
import { iconFor } from "@compforge/aide-plugin";
/** Channel identity and presentation; transport lifecycle stays with each adapter. */
export interface ChannelDefinition {
  readonly id: string;
  readonly label: string;
  /** SVG path data in a 24 x 24 viewBox; never markup or a remote URL. */
  readonly icon: string;
}

export const CHANNELS = {
  web: { id: "web", label: "Web", icon: iconFor("channel:web") },
  lark: { id: "lark", label: "Lark", icon: iconFor("channel:lark") },
} as const satisfies Record<string, ChannelDefinition>;

export type ChannelInput = Omit<Incoming, "channelId">;

export function bindChannelInput(definition: ChannelDefinition, receive: (input: Incoming) => Promise<InputReceipt>) {
  return (input: ChannelInput) => receive({ ...input, channelId: definition.id });
}
