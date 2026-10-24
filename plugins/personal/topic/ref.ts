import { z } from "zod";
export const ResourceRefSchema = z.object({ apiVersion: z.literal("aide.dev/v1alpha1"), kind: z.literal("Topic"),
  namespace: z.literal("v1"), name: z.string().min(1), uid: z.string().min(1) }).strict();
