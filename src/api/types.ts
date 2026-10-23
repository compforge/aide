import type { ConversationSummary } from "../channel/view.ts";
import type { Persons } from "../../plugins/personal/person/service.ts";

/** HTTP projections shared with browser consumers; imports here remain type-only. */
export type ConversationItem = ConversationSummary & { taskCount: number; routineCount: number };
export type PersonView = Awaited<ReturnType<Persons["read"]>>;
export type InputListView = ReturnType<typeof import("./inputs.ts").inputList>;
export type InputDetailView = NonNullable<ReturnType<typeof import("./inputs.ts").inputDetail>>;
export type { InputRequest as Approval } from "../host/message/types.ts";
