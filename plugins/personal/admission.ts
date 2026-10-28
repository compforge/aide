import { statusPatch } from "./status.ts";
import { topicSubtree } from "./topic/tree.ts";
import { isDeepStrictEqual } from "node:util";
import { TASK_TYPE, type TaskSpec } from "./task/model.ts";
import { TOPIC_TYPE, type TopicSpec, type TopicStatus } from "./topic/model.ts";
import { digest } from "./chief-model.ts";
import { resourceRef } from "./input/state.ts";
import type { ResourceAdmission } from "../../src/host/plugin/resource/client.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "./input/model.ts";
import { OUTPUT_TYPE, type OutputSpec } from "./output/model.ts";
import type { InputStore } from "./input/store.ts";
import type { OutputStore } from "./output/store.ts";

/** @spec Personal owns immutable fact admission and redelivery receipts; the runtime only supplies the transaction. */
export function personalAdmission(inputs: InputStore, outputs: OutputStore): ResourceAdmission {
  return (type, init, writes) => {
    if (type.apiVersion === TASK_TYPE.apiVersion && type.kind === TASK_TYPE.kind) {
      if (init.namespace && init.namespace !== "v1") throw new Error("Task uses the Personal global namespace");
      const spec = init.spec as TaskSpec;
      if (!spec.initialInputId) throw new Error("Task requires an initial Input");
      const input = inputs.get(spec.initialInputId);
      const target = (init.status as import("./task/model.ts").TaskStatus).topic;
      const topic = inputs.resources.get<TopicSpec, TopicStatus>(TOPIC_TYPE, target.name, target.namespace);
      if (topic.metadata.uid !== target.uid) throw new Error("Task Topic was replaced");
      const members = new Set(topicSubtree(topic, parent => inputs.resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE, { namespace: parent.metadata.namespace, matchIndex: { name: "parent", value: parent.metadata.uid } })).map(t => t.metadata.uid));
      const attached = input && input.status.topic && members.has(input.status.topic.uid);
      if (topic.metadata.deletionTimestamp || !input || input.metadata.deletionTimestamp || !attached)
        throw new Error("Initial Input is not assigned to the Task Topic");
      const existing = inputs.resources.find(TASK_TYPE, init.name);
      if (existing) {
        if (existing.metadata.deletionTimestamp || !isDeepStrictEqual(existing.spec, spec)) throw new Error("Task creation identity is already used");
        return existing;
      }
      const task = writes.create(type, init);
      writes.patchStatus(input, statusPatch(input, { handle: { ...input.status.handle, [task.metadata.uid]: {
        resource: resourceRef(task), assignedAt: new Date().toISOString(), request: { action: "context" },
      } } }));
      return task;
    }
    if (type.apiVersion === INPUT_TYPE.apiVersion && type.kind === INPUT_TYPE.kind) {
      if (init.namespace && init.namespace !== "v1") throw new Error("Input uses the Personal global namespace");
      const spec = init.spec as InputSpec;
      return inputs.submit(spec.topicKey ?? spec.topicId ?? "personal", init.name, spec, init.status as InputStatus | undefined);
    }
    if (type.apiVersion === OUTPUT_TYPE.apiVersion && type.kind === OUTPUT_TYPE.kind) {
      if (init.namespace && init.namespace !== "v1") throw new Error("Output uses the Personal global namespace");
      const spec = init.spec as OutputSpec;
      return outputs.create(spec.topicId, init.name, spec);
    }
  };
}
