import type { Resource } from "@compforge/aide-plugin";
import type { InputSpec, InputStatus } from "./model.ts";
import { inputPrinter } from "./printer.ts";
import { z } from "zod";
import { messagePreview } from "../source/message/prompt.ts";
import { SOURCES } from "../source/definition.ts";

const LarkParticipants = z.object({ provider: z.literal("lark"), accountId: z.string(),
  chatId: z.string(), chatName: z.string().optional(), chatType: z.string(), sender: z.object({ id: z.string().optional(), type: z.string() }),
  assistant: z.object({ id: z.string(), name: z.string() }).optional(), mentions: z.array(z.string()),
});

/** @spec Only the accepting Channel establishes that a message addresses Aide; sent alone does not.
 * @link docs/kernel.md#输入关系与交流对象
 */
function communication(input: InputSpec): string {
  if (input.origin === "chief") return "Originating actor: Aide. This is an assistant decision within existing authority, not a new statement by Me.\n";
  if (input.origin !== "channel") return "External observation. Identify its speakers and addressees; relation is relative to Me, not Aide.\n";
  if (input.originId === "web") return "Direct conversation: Me → Aide through the local Web channel.\n";
  if (input.originId !== "lark") return "";
  const parsed = LarkParticipants.safeParse(input.observation);
  return "Message accepted by Aide's Lark channel (bot DM or exact bot mention). The sender is not necessarily Me.\n"
    + (parsed.success ? `Channel participants (IDs scoped by accountId; assistant absent means its ID is unknown): ${JSON.stringify(parsed.data)}\n` : "Participant details unavailable; inspect read_input rather than guessing identities.\n");
}

/**
 * @spec Automatic input material includes identity and text, with evidence retrieved on demand through read_input.
 * @why Full observation snapshots belong to the Input, not every Route/Chief/Work model call.
 * @link docs/personal/input.md
 */
export function inputPreview(input: Readonly<Resource<InputSpec, InputStatus>>, maxChars = 12000): string {
  const text = input.spec.origin === "source" && input.spec.originId === SOURCES.lark.id
    ? messagePreview(input.spec.observation) ?? input.spec.text : input.spec.text;
  const body = communication(input.spec) + inputPrinter.describe({ ...input, spec: { ...input.spec, text, observation: undefined } });
  const evidence = input.spec.observation === undefined ? "" : "\nAdditional observation evidence is available through read_input. Read it when needed for the decision; it is not included in this preview.";
  const truncated = "\n[Text truncated; use read_input for the complete Input.]";
  const budget = Math.max(0, maxChars - evidence.length);
  return (body.length <= budget ? body : body.slice(0, Math.max(0, budget - truncated.length)) + truncated) + evidence;
}
