import { TopicDefinition } from "../../plugins/personal/topic/definition.ts";
import { InputDefinition } from "../../plugins/personal/input/definition.ts";
import { definition } from "./resource-definition.ts";
import { TaskDefinition } from "../../plugins/personal/task/definition.ts";
import { RoutineDefinition } from "../../plugins/personal/routine/definition.ts";
export default [TopicDefinition, InputDefinition, TaskDefinition, RoutineDefinition, definition({ apiVersion: "tests.aide.dev/v1alpha1", kind: "WorkObserver" })];
