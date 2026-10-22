import { z } from "zod";
import type { ExecutionAssociation } from "@compforge/aide-plugin";

const Association = z.object({
  conversationId: z.string().optional(),
  inputId: z.string().optional(),
  inputIds: z.array(z.string()).optional(),
});
export function personalExecution(context: ExecutionAssociation) {
  return Association.parse(context.attributes ?? {});
}
