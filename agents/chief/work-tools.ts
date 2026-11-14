import { workTools as sharedWorkTools } from "../work-tools.ts";
import { INPUT_ORIGINS, BUSINESS_INPUT_ORIGINS, type ChiefToolDefinition } from "./input-tools.ts";
import type { WorkService } from "../../plugins/personal/work.ts";

export function workTools(work: WorkService): ChiefToolDefinition[] {
  return sharedWorkTools(work).map(tool => ({ ...tool,
    inputOrigins: ["list_work", "read_work"].includes(tool.name) ? INPUT_ORIGINS : BUSINESS_INPUT_ORIGINS }));
}
