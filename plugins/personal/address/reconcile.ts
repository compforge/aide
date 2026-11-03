import type { PluginContext, ReconcileRequest } from "@compforge/aide-plugin";
import { ADDRESS_TYPE, type AddressResource } from "./model.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import type { Resource } from "@compforge/aide-plugin";
import { equalResourceValue } from "../../../src/resource/value.ts";
export function registerAddresses(context: PluginContext): void {
  const request = (input: Resource<InputSpec, InputStatus>): ReconcileRequest[] => input.spec.source ? [{ name: input.spec.source.name, namespace: "v1" }] : [];
  context.controllers.register({ resourceType: ADDRESS_TYPE, watches: [{ resourceType: INPUT_TYPE, handler: {
    create: async ({ object }) => request(object as Resource<InputSpec, InputStatus>), update: async () => [], delete: async () => [],
  } }, { resourceType: ADDRESS_TYPE, handler: { create: async () => [], delete: async () => [],
    update: async ({ oldObject, newObject }) => !equalResourceValue((oldObject as AddressResource).status.mergeSources, (newObject as AddressResource).status.mergeSources)
      ? [{ name: newObject.metadata.name, namespace: "v1" }] : [],
  } }], reconcile: async (execution, address: Readonly<AddressResource>) => {
    if (address.metadata.deletionTimestamp) return;
    const result = await execution.verbs.action<{ requeueAfterMs?: number } | undefined>("reconcile_address", { address: { ...ADDRESS_TYPE, namespace: "v1", name: address.metadata.name, uid: address.metadata.uid } });
    if (result.state !== "success") throw new Error("Address coordination did not complete");
    return result.value;
  } });
}
