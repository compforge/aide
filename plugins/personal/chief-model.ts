import { createHash } from "node:crypto";

export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const chiefTarget = (conversationId: string) => `chief:${digest(conversationId)}`;
export { INPUT_TYPE, CONVERSATION_TYPE } from "@compforge/aide-plugin";
export type { InputSpec, InputStatus, InputQuestion as ChiefQuestion } from "@compforge/aide-plugin";
