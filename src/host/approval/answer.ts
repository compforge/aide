import type { ApprovalDraft, ApprovalResult } from "./types.ts";

/** A reply becomes an effective InputResponse only after its request-specific contract passes. */
export function validInputResult(request: ApprovalDraft, result: ApprovalResult): boolean {
  if (result.kind === "cancelled") return true;
  switch (request.kind) {
    case "permission":
      return result.kind === "permission" && result.outcome === "selected" &&
        request.options.some((option) => option.optionId === result.optionId);
    case "hook_trust":
      return result.kind === "hook_trust" && (result.outcome === "trusted" || result.outcome === "skipped");
  }
}
