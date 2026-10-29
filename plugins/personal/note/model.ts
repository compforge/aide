import { z } from "zod";
import type { Resource } from "@compforge/aide-plugin";
import { PersonRefSchema } from "../person/model.ts";

export const NOTE_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Note" } as const;
export const SubjectSchema = z.object({ apiVersion: z.string().min(1), kind: z.enum(["Topic", "Task", "Routine"]),
  namespace: z.literal("v1"), name: z.string().min(1), uid: z.string().min(1) }).strict();
export const NoteSpecSchema = z.object({ subject: SubjectSchema, people: z.array(PersonRefSchema).default([]),
  text: z.string().trim().min(1).max(16000) }).strict();
export const NoteWriterSchema = z.object({ resource: SubjectSchema, executionId: z.string().min(1) }).strict();
export const NoteStatusSchema = z.object({ updatedAt: z.string().datetime(), writer: NoteWriterSchema }).strict();
export const NoteViewSchema = NoteSpecSchema.extend({ id: z.string(), uid: z.string(), version: z.string(), createdAt: z.string(), updatedAt: z.string() });
export type NoteSpec = z.infer<typeof NoteSpecSchema>;
export type NoteStatus = z.infer<typeof NoteStatusSchema>;
export type NoteResource = Resource<NoteSpec, NoteStatus>;
/** A query projection; never embedded in another persisted Resource. */
export interface Note extends NoteSpec { id: string; uid: string; version: string; createdAt: string; updatedAt: string }
export const noteVersion = (r: NoteResource) => `${r.metadata.uid}:${r.metadata.resourceVersion}`;
export const noteView = (r: NoteResource): Note => ({ ...r.spec, id: r.metadata.name, uid: r.metadata.uid,
  version: noteVersion(r), createdAt: r.metadata.creationTimestamp, updatedAt: r.status.updatedAt });
