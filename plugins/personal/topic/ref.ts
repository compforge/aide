import { z } from "zod";
export const ResourceRefSchema = z.object({ apiVersion: z.literal("aide.dev/v1alpha2"), kind: z.literal("Topic"),
  namespace: z.literal("v1"), name: z.string().min(1), uid: z.string().min(1) }).strict();

export const OrganizationSchema = z.object({ at: z.string().datetime(), reason: z.string().min(1).max(2000), actorUid: z.string(),
  fromUid: z.string().optional(), toUid: z.string().optional() }).strict();
export type Organization = z.infer<typeof OrganizationSchema>;
