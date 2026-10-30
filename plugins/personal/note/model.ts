import { createHash } from "node:crypto";
import { z } from "zod";
import type { Resource } from "@compforge/aide-plugin";
import { PersonRefSchema } from "../person/model.ts";

export const NOTE_TYPE = { apiVersion: "aide.dev/v1alpha2", kind: "Note" } as const;
export const WriterResourceSchema = z.object({ apiVersion: z.string().min(1), kind: z.enum(["Topic", "Task", "Routine"]),
  namespace: z.literal("v1"), name: z.string().min(1), uid: z.string().min(1) }).strict();
export const SubjectSchema = WriterResourceSchema.extend({ kind: z.enum(["Topic", "Task", "Routine", "Person"]) });
export const NoteSpecSchema = z.object({ subject: SubjectSchema, summaryOf: SubjectSchema.optional(), people: z.array(PersonRefSchema).default([]),
  text: z.string().max(16000) }).strict();
export const NoteWriterSchema = z.object({ resource: WriterResourceSchema, executionId: z.string().min(1) }).strict();
export const NoteStatusSchema = z.object({ updatedAt: z.string().datetime(), writer: NoteWriterSchema.optional(),
  reviewTopic: SubjectSchema.extend({ kind: z.literal("Topic") }).optional(),
  reviewed: z.object({ version: z.string(), at: z.string().datetime() }).strict().optional(),
  organization: z.object({ at: z.string().datetime(), reason: z.string().min(1), from: SubjectSchema, to: SubjectSchema }).strict().optional(),
}).strict();
export const NoteViewSchema = NoteSpecSchema.extend({ id: z.string(), uid: z.string(), version: z.string(), createdAt: z.string(), updatedAt: z.string() });
export type NoteSpec = z.infer<typeof NoteSpecSchema>;
export type NoteStatus = z.infer<typeof NoteStatusSchema>;
export type NoteResource = Resource<NoteSpec, NoteStatus>;
/** A query projection; never embedded in another persisted Resource. */
export interface Note extends NoteSpec { id: string; uid: string; version: string; createdAt: string; updatedAt: string }
/** @spec Review receipts do not change the content version or refresh a Note's retention age. */
export const noteVersion = (r: NoteResource) => createHash("sha256").update(JSON.stringify([r.metadata.uid, r.spec, r.status.updatedAt])).digest("hex");
export const noteView = (r: NoteResource): Note => ({ ...r.spec, id: r.metadata.name, uid: r.metadata.uid,
  version: noteVersion(r), createdAt: r.metadata.creationTimestamp, updatedAt: r.status.updatedAt });

/** Identity and associations travel with summary previews without duplicating the body. */
export const NoteReferenceSchema = NoteViewSchema.omit({ text: true, createdAt: true, updatedAt: true });
export type NoteReference = z.infer<typeof NoteReferenceSchema>;
export const noteReference = (note: NoteResource | undefined): NoteReference | undefined => note
  ? { id: note.metadata.name, uid: note.metadata.uid, version: noteVersion(note), subject: note.spec.subject, ...(note.spec.summaryOf ? { summaryOf: note.spec.summaryOf } : {}), people: note.spec.people } : undefined;
/** Automatic context bounds associations; explicit read_note returns the complete list. */
export const previewNoteReference = (ref: NoteReference | undefined) => ref ? { ...ref, people: ref.people.slice(0, 8),
  ...(ref.people.length > 8 ? { peopleOmitted: ref.people.length - 8 } : {}) } : undefined;
