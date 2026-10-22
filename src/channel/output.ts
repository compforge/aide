import { isChannelAddress } from "./address.ts";
import type { ChannelService } from "./service.ts";
import type { OutputView } from "../output.ts";

export function channelOutputs(service: Pick<ChannelService, "outputs">): OutputView[] { return service.outputs(); }

/** Web shows the producing Conversation's record and messages explicitly delivered to this endpoint. */
export function visibleOutput(output: OutputView, conversation: { spec: { id: string }; metadata: { uid: string; creationTimestamp: string } }): boolean {
  if (output.conversationId === conversation.spec.id) return output.conversationUid === conversation.metadata.uid;
  // A new destination Conversation does not inherit messages delivered before its creation.
  return isChannelAddress(output.target) && output.target.channelId === "web" && output.target.endpoint === conversation.spec.id
    && output.at >= conversation.metadata.creationTimestamp;
}
