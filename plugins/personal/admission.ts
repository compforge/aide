import type { ResourceAdmission } from "../../src/host/plugin/resource/client.ts";
import { INPUT_TYPE, type InputSpec } from "./input/model.ts";
import { OUTPUT_TYPE, type OutputSpec } from "./output/model.ts";
import type { InputStore } from "./input/store.ts";
import type { OutputStore } from "./output/store.ts";

/** @spec Personal owns immutable fact admission and redelivery receipts; the runtime only supplies the transaction. */
export function personalAdmission(inputs: InputStore, outputs: OutputStore): ResourceAdmission {
  return (type, init) => {
    if (type.apiVersion === INPUT_TYPE.apiVersion && type.kind === INPUT_TYPE.kind) {
      if (init.namespace && init.namespace !== "v1") throw new Error("Input uses the Personal global namespace");
      const spec = init.spec as InputSpec;
      return inputs.submit(spec.sessionId ?? "personal", init.name, spec);
    }
    if (type.apiVersion === OUTPUT_TYPE.apiVersion && type.kind === OUTPUT_TYPE.kind) {
      if (init.namespace && init.namespace !== "v1") throw new Error("Output uses the Personal global namespace");
      const spec = init.spec as OutputSpec;
      return outputs.create(spec.conversationId, init.name, spec);
    }
  };
}
