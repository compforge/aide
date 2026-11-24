import { z } from "zod";
import { ResourceAlreadyExists, type ResourceClient } from "@compforge/aide-plugin";
import { digest } from "../identity.ts";
import { resourceRef } from "../input/state.ts";
import { ResourceRefSchema } from "../topic/ref.ts";
import { isGateTopic } from "../topic/boundary.ts";
import { readTopicInScope } from "../topic/tree.ts";
import type { TopicResource } from "../topic/model.ts";
import { ONGOING_TYPE, OngoingSpecSchema, OngoingStatusSchema, ongoingView, type OngoingSpec, type OngoingStatus } from "./model.ts";

const UpdateSchema = z.object({
  ongoingId: z.string().min(1).optional(), version: z.string().min(1).optional(), title: OngoingSpecSchema.shape.title.optional(),
  question: OngoingSpecSchema.shape.question.nullable(), checkAt: OngoingSpecSchema.shape.checkAt.nullable(),
  progress: OngoingStatusSchema.shape.progress, outcome: z.string().trim().min(1).max(2000).optional(),
}).strict();

export async function readOngoing(resources: ResourceClient, actor: TopicResource, id: string) {
  const matter = await resources.get<OngoingSpec, OngoingStatus>({ ...ONGOING_TYPE, namespace: "v1", name: id });
  if (!matter || matter.metadata.deletionTimestamp || (!isGateTopic(actor) && !await readTopicInScope(resources, actor, matter.spec.topic.uid)))
    throw new Error("Ongoing is unavailable in this Chief's scope");
  return matter;
}

export async function upsertOngoing(resources: ResourceClient, actor: TopicResource, raw: unknown, callId: string) {
  const args = UpdateSchema.parse(raw);
  const executionId = actor.status.execution?.id;
  if (!executionId || !callId) throw new Error("Ongoing requires a Chief execution and tool-call identity");
  const writer = { resource: ResourceRefSchema.parse(resourceRef(actor)), executionId };
  const now = new Date();
  const updatedAt = now.toISOString();
  if (!args.ongoingId) {
    if (!args.title || args.outcome || args.checkAt === null || args.version) throw new Error("Creating an Ongoing requires a title and an open check");
    const id = `ongoing-${digest([actor.metadata.uid, executionId, callId]).slice(0, 32)}`;
    const ref = { ...ONGOING_TYPE, namespace: "v1" as const, name: id };
    const spec = { topic: writer.resource, title: args.title, ...(args.question ? { question: args.question } : {}),
      checkAt: args.checkAt ?? new Date(now.getTime() + 86_400_000).toISOString() };
    const existing = await resources.get<OngoingSpec, OngoingStatus>(ref);
    if (existing) return ongoingView(existing);
    try {
      return ongoingView(await resources.create(ONGOING_TYPE, { name: id, spec, status: { writer, updatedAt, planRevision: 1, ...(args.progress ? { progress: args.progress } : {}) } }));
    } catch (error) {
      if (!(error instanceof ResourceAlreadyExists) && !(error instanceof Error && error.name === "ResourceAlreadyExists")) throw error;
      return ongoingView(await readOngoing(resources, actor, id));
    }
  }
  const matter = await readOngoing(resources, actor, args.ongoingId);
  if (matter.status.closure || matter.metadata.resourceVersion !== args.version) throw new Error("Ongoing closed or version changed; read it again");
  if (args.outcome && (args.checkAt || args.question)) throw new Error("Close or schedule Ongoing separately");
  const checkAt = args.outcome || args.checkAt === null ? undefined : args.checkAt ?? matter.spec.checkAt;
  if (args.question && !checkAt) throw new Error("Set checkAt to schedule this question");
  const question = !checkAt || args.question === null ? undefined : args.question ?? matter.spec.question;
  const revised = checkAt !== matter.spec.checkAt || question !== matter.spec.question;
  const spec = { topic: matter.spec.topic, title: args.title ?? matter.spec.title, ...(checkAt ? { checkAt } : {}), ...(question ? { question } : {}) };
  const status = { ...matter.status, writer, updatedAt, ...(args.progress ? { progress: args.progress } : {}),
    planRevision: matter.status.planRevision + Number(revised), ...(args.outcome ? { closure: { at: updatedAt, outcome: args.outcome } } : {}) };
  return ongoingView(await resources.replace(matter, spec, status));
}
