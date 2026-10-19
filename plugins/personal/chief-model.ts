import { createHash } from "node:crypto";
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const chiefTarget = (conversationId: string) => `chief:${digest(conversationId)}`;
export const chiefRouterTarget = (sessionId: string) => `chief-router:${digest(sessionId)}`;
export { INPUT_TYPE } from "@compforge/aide-plugin";
export type { InputSpec, InputStatus } from "@compforge/aide-plugin";
export { CONVERSATION_TYPE } from "./conversation-model.ts";
export type { ChiefQuestion } from "./conversation-model.ts";
