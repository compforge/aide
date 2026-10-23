import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { OutputStore } from "./store.ts";

const parameters = Type.Object({ outputId: Type.String({ minLength: 1 }) });

/** @spec Delivery receipts are read from the durable Output in the caller's current business scope. */
export function outputStatusTool(store: OutputStore, scope: () => { conversationUid: string; producerUid?: string }): ToolDefinition<typeof parameters> {
  return {
    name: "read_output", label: "Read Output delivery",
    description: "Read the durable status of an Output created in this scope. Only delivered confirms delivery, never that a person read it. Pending/sending are not success; failed/uncertain require inspection. Do not poll in a loop or recreate an Output just because it is pending.",
    parameters,
    async execute(_id, args) {
      const owner = scope(), output = store.get(args.outputId);
      if (!output || output.spec.conversation.uid !== owner.conversationUid ||
        (owner.producerUid && output.spec.producer?.uid !== owner.producerUid)) throw new Error("Output is not in this scope");
      return { content: [{ type: "text", text: JSON.stringify({ outputId: output.metadata.name, target: output.spec.target, status: output.status }) }], details: {} };
    },
  };
}
