import { definition } from "./resource-definition.ts";
import { TaskDefinition } from "../../plugins/personal/task/definition.ts";
import { RoutineDefinition } from "../../plugins/personal/routine/definition.ts";
export default [TaskDefinition, RoutineDefinition, definition({ apiVersion: "tests.aide.dev/v1alpha1", kind: "WorkObserver" }, "shared")];
