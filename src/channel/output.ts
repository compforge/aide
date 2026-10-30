import { isChannelAddress } from "./address.ts";
import type { ChannelService } from "./service.ts";
import type { OutputView } from "../output.ts";

export function channelOutputs(service: Pick<ChannelService, "outputs">): OutputView[] { return service.outputs().filter(output => !!output.status.delivery && !!output.status.disclosure); }

/** Web shows the producing Topic's record and messages explicitly delivered to this endpoint. */
export function visibleOutput(output: OutputView, topic: { spec: { id: string }; metadata: { uid: string; creationTimestamp: string } }): boolean {
  if (output.topicId === topic.spec.id) return output.topicUid === topic.metadata.uid;
  // A new destination Topic does not inherit messages delivered before its creation.
  return isChannelAddress(output.target) && output.target.channelId === "web" && output.target.endpoint === topic.spec.id
    && output.at >= topic.metadata.creationTimestamp;
}
