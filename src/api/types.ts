import type { Persons } from "../../plugins/personal/person/service.ts";

/** HTTP projections shared with browser consumers; imports here remain type-only. */
export type TopicItem = import("../../plugins/personal/topic/browse.ts").TopicListItem;
export type TopicListView = ReturnType<typeof import("../../plugins/personal/topic/browse.ts").browseTopics>;
export type PersonItem = import("../../plugins/personal/person/browse.ts").PersonListItem;
export type PersonListView = ReturnType<typeof import("../../plugins/personal/person/browse.ts").browsePersons>;
export type PersonView = Awaited<ReturnType<Persons["read"]>>;
export type InputListView = ReturnType<typeof import("./inputs.ts").inputList>;
export type InputFiltersView = ReturnType<typeof import("./inputs.ts").inputFilters>;
export type InputDetailView = NonNullable<ReturnType<typeof import("./inputs.ts").inputDetail>>;
export type { InputRequest as Approval } from "../host/message/types.ts";

export type PersonNotesView = Awaited<ReturnType<Persons["notes"]>>;
