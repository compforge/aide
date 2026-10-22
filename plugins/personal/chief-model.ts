import { createHash } from "node:crypto";
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const chiefTarget = (conversationId: string) => `chief:${digest(conversationId)}`;
export { INPUT_TYPE } from "./input/model.ts";
export type { InputSpec, InputStatus } from "./input/model.ts";
export { CONVERSATION_TYPE } from "./conversation/model.ts";
