import { z } from "zod";
import type { PluginVerbs } from "@compforge/aide-plugin";
import type { SayInput, SayResult, SayReceipt } from "./model.ts";
import { OutputSpecSchema } from "./definition.ts";
export const SayInputSchema = z.object({ text: z.string().trim().min(1), inputIds: z.array(z.string()).optional(),
  idempotencyKey: z.string().min(1).optional(), respondToInputId: z.string().min(1).optional(),
  target: OutputSpecSchema.shape.target.optional(), receivers: OutputSpecSchema.shape.receivers.optional() }).strict();
export async function say(verbs: PluginVerbs, input: SayInput): Promise<SayResult> {
  return verbs.action<SayReceipt>("say", SayInputSchema.parse(input));
}
