import { Type } from "typebox";

export const summaryDescription = "Revise long-lived, infrequently changing understanding, not temporary state or a transcript. It may be incomplete or mistaken. When the character budget forces removal, compare importance, stability and lasting usefulness: newer or more detailed facts do not automatically outweigh existing understanding. Preserve attribution, explicit user corrections, uncertainty and authorization boundaries. Temporary progress belongs in upsert_note. Read the target first and supply its latest version. This does not acknowledge Inputs, complete work or grant authority.";
export const noteDescription = "Read existing Notes first. Omit noteId to create; supply noteId to update the same matter through its start, progress and conclusion. text is the complete current understanding of that matter across inputs, not just the latest increment. Preserve the author, relevant evidence and uncertainty; reported completion is different from verified completion. Uses the latest target version. Use optional persons for identified people involved in this matter, with UID-pinned references from Input evidence or read_person. Omit persons to preserve existing associations; [] clears them. Preserve associations when synthesizing child Notes. Do not create Notes merely to enumerate people. Does not change long-lived summary or acknowledge Inputs.";
export const noteFields = {
  persons: Type.Optional(Type.Array(Type.Object({ apiVersion: Type.Literal("aide.dev/v1alpha1"), kind: Type.Literal("Person"),
    namespace: Type.Literal("v1"), name: Type.String({ minLength: 1 }), uid: Type.String({ minLength: 1 }) }, { additionalProperties: false }))),
  version: Type.String({ minLength: 1, description: "Latest resource version returned by reading this Note's owner." }),
  noteId: Type.Optional(Type.String({ minLength: 1, description: "Existing Note ID on the selected resource; omit only for a new matter." })),
  text: Type.String({ minLength: 1, maxLength: 16000, description: "Complete current understanding of one recent matter, including relevant author and confirmation state." }),
};
