import { InputDefinition } from "./input/definition.ts";
import { OutputDefinition } from "./output/definition.ts";
import { ConversationDefinition } from "./conversation/definition.ts";
import { TaskDefinition } from "./task/definition.ts";
import { RoutineDefinition } from "./routine/definition.ts";
import { EnvironmentSourceDefinition } from "./source/environment/definition.ts";
import { MessageSourceDefinition } from "./source/message/definition.ts";
import { RequirementSourceDefinition } from "./source/requirement/definition.ts";
export default [InputDefinition, OutputDefinition, ConversationDefinition, TaskDefinition, RoutineDefinition, EnvironmentSourceDefinition, MessageSourceDefinition, RequirementSourceDefinition];
