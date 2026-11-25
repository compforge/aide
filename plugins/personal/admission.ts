import { ONGOING_TYPE, type OngoingSpec } from "./ongoing/model.ts";
import { composeMail, type MailDraft } from "./stream/writer.ts";
import { statusPatch } from "./status.ts";
import { topicSubtree } from "./topic/tree.ts";
import { isDeepStrictEqual } from "node:util";
import { TASK_TYPE, type TaskSpec } from "./task/model.ts";
import { GATE_TOPIC_ID, TOPIC_TYPE, type TopicSpec, type TopicStatus } from "./topic/model.ts";
import { digest } from "./identity.ts";
import { resourceRef } from "./input/state.ts";
import type { ResourceAdmission } from "../../src/host/plugin/resource/client.ts";
import { INPUT_TYPE, isInternalInput, type InputSpec, type InputStatus } from "./input/model.ts";
import { OUTPUT_TYPE } from "./output/model.ts";
import type { InputStore } from "./input/store.ts";
import type { OutputStore } from "./output/store.ts";

/** @spec Personal owns immutable fact admission and redelivery receipts; the runtime only supplies the transaction. */
export function personalAdmission(inputs: InputStore, outputs: OutputStore): ResourceAdmission {
  return (type, init, writes) => {
    if (type.apiVersion === TOPIC_TYPE.apiVersion && type.kind === TOPIC_TYPE.kind) {
      const spec = init.spec as TopicSpec;
      if (spec.id !== GATE_TOPIC_ID && !spec.parentRef) {
        const gate = inputs.resources.find<TopicSpec, TopicStatus>(TOPIC_TYPE, digest(GATE_TOPIC_ID))
          ?? writes.create(TOPIC_TYPE, { name: digest(GATE_TOPIC_ID), spec: { id: GATE_TOPIC_ID, name: "Gate", review: { enabled: false } }, status: { receipts: [] } });
        return writes.create(type, { ...init, spec: { ...spec, parentRef: resourceRef(gate) } });
      }
    }
    const isOngoing = type.kind === ONGOING_TYPE.kind && type.apiVersion === ONGOING_TYPE.apiVersion;
    if ((type.apiVersion === TASK_TYPE.apiVersion && type.kind === TASK_TYPE.kind) || isOngoing && (init.spec as OngoingSpec).initialInputId) {
      if (init.namespace && init.namespace !== "v1") throw new Error("Work uses the Personal global namespace");
      const spec = init.spec as TaskSpec | OngoingSpec;
      if (!spec.initialInputId) throw new Error("Task requires an initial Input");
      const input = inputs.get(spec.initialInputId);
      const target = isOngoing ? (init.spec as OngoingSpec).topic : (init.status as import("./task/model.ts").TaskStatus).topic;
      const topic = inputs.resources.get<TopicSpec, TopicStatus>(TOPIC_TYPE, target.name, target.namespace);
      if (topic.metadata.uid !== target.uid) throw new Error("Work Topic was replaced");
      const members = new Set(topicSubtree(topic, parent => inputs.resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE, { namespace: parent.metadata.namespace, matchIndex: { name: "parent", value: parent.metadata.uid } })).map(t => t.metadata.uid));
      const attached = input && input.status.topic && members.has(input.status.topic.uid);
      if (topic.metadata.deletionTimestamp || !input || input.metadata.deletionTimestamp || !attached)
        throw new Error("Initial Input is not assigned to the Work Topic");
      if (isInternalInput(input.spec)) throw new Error("Maintenance Input cannot be delegated");
      const existing = inputs.resources.find(type, init.name);
      if (existing) {
        if (existing.metadata.deletionTimestamp || !isDeepStrictEqual(existing.spec, spec)) throw new Error("Work creation identity is already used");
        return existing;
      }
      const work = writes.create(type, init);
      const at = new Date().toISOString();
      writes.patchStatus(input, statusPatch(input, { handle: { ...input.status.handle, [work.metadata.uid]: {
        resource: resourceRef(work), assignedAt: at, ...(isOngoing ? { completedAt: at } : {}), request: { action: "context" },
      } } }));
      return work;
    }
    if (type.apiVersion === INPUT_TYPE.apiVersion && type.kind === INPUT_TYPE.kind) {
      if (init.namespace && init.namespace !== "v1") throw new Error("Input uses the Personal global namespace");
      const spec = init.spec as InputSpec;
      return inputs.submit(spec.topicKey ?? spec.topicId ?? "personal", init.name, spec, init.status as InputStatus | undefined);
    }
    if (type.apiVersion === OUTPUT_TYPE.apiVersion && type.kind === OUTPUT_TYPE.kind) {
      if (init.namespace && init.namespace !== "v1") throw new Error("Output uses the Personal global namespace");
      const draft = init.spec as MailDraft;
      return composeMail(outputs, draft.topicId, init.name, draft);
    }
  };
}
