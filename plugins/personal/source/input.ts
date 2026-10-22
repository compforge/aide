import type { Resource, ResourceClient } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
/** Input-producing Source identity; distinct from a Controller's resource discovery lifecycle. */
export interface SourceDefinition {
  readonly id: string;
  readonly label: string;
  /** SVG path data in a 24 x 24 viewBox; never markup or a remote URL. */
  readonly icon: string;
}


export type SourceInput = Omit<InputSpec, "origin" | "originId" | "originRef">;

/** @spec A Source-bound input port stamps category and concrete resource identity before durable submission. */
export function bindSourceInput(definition: SourceDefinition, resource: Resource<unknown, unknown>, resources: ResourceClient) {
  const { apiVersion, kind, metadata: { sessionId, namespace, name, uid } } = resource;
  const originRef = { apiVersion, kind, ...(sessionId ? { sessionId } : {}), namespace, name, uid };
  return (inputId: string, spec: SourceInput) => resources.create<InputSpec, InputStatus>(INPUT_TYPE, {
    name: inputId, spec: { ...spec, origin: "source", originId: definition.id, originRef },
  });
}

