import { parseResourceNamespace } from "../plugin/namespace.ts";
import { z } from "zod";
import { STREAM_TYPE, type Stream, type ResourceDefinition } from "@compforge/aide-plugin";

export const StreamRefSchema = z.object({ apiVersion: z.literal(STREAM_TYPE.apiVersion), kind: z.literal("Stream"),
  namespace: z.string().transform(value => value === "v1" ? value : parseResourceNamespace(value)), name: z.string().min(1), uid: z.string().min(1) }).strict();
export const StreamDefinition: ResourceDefinition<Stream["spec"], Stream["status"]> = {
  type: STREAM_TYPE,
  schema: { spec: z.object({ protocol: z.string().min(1) }).strict(), status: z.object({ phase: z.enum(["open", "completed", "interrupted"]),
    lastSeq: z.number().int().nonnegative(), references: z.array(z.object({ apiVersion: z.string(), kind: z.string(), uid: z.string(), version: z.string(), contentVersion: z.string().optional() }).strict()).max(100), closedAt: z.iso.datetime().optional(), error: z.string().optional() }).strict() },
  validator: {
    create(resource) { if (!resource.metadata.owner) throw new Error("Stream requires a structural owner"); },
    update(before, after) {
      if (before.spec.protocol !== after.spec.protocol) throw new Error("Stream protocol is immutable");
      if (before.status.phase !== "open" && JSON.stringify(before.status) !== JSON.stringify(after.status)) throw new Error("Closed Stream is immutable");
      if (after.status.lastSeq < before.status.lastSeq) throw new Error("Stream sequence cannot decrease");
      if ((after.status.phase === "open") === !!after.status.closedAt) throw new Error("Stream close state is inconsistent");
    },
  },
  printer: { summarize: r => `${r.status.phase} · ${r.status.lastSeq} records`, describe: r => JSON.stringify(r, null, 2) },
  retention: { releasedAt: r => r.status.closedAt, references: () => [] },
};
