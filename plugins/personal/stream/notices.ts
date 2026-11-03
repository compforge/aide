import { createHash } from "node:crypto";
import type { Output } from "../output/model.ts";
import type { OutputStore } from "../output/store.ts";
import { replacementMail, mailView } from "./writer.ts";
export const MUTED_OUTPUT_TEXT = "我当前被禁言。如需听我发言，请解除该地址的禁言。";
export const muteMail = (store: OutputStore, output: Output) => replacementMail(store, output, "muted", MUTED_OUTPUT_TEXT);
/** Fixed system mail is authorized by its immutable owned identity, never by parsing generated text. */
export function isMuteMail(store: OutputStore, output: Output): boolean {
  const delivery = output.status.delivery;
  const hash = createHash("sha256").update(MUTED_OUTPUT_TEXT).digest("hex").slice(0, 16);
  if (delivery?.notice !== "muted" || delivery.stream.uid !== `stream:${output.metadata.uid}:muted:${hash}`) return false;
  const stream = store.streams.get(delivery.stream);
  return stream.metadata.owner?.uid === output.metadata.uid && stream.status.phase === "completed";
}
export function refusalMail(store: OutputStore, output: Output, reason: string) {
  return replacementMail(store, output, "disclosure", `原计划发送至：${JSON.stringify(output.spec.target)}\n未发送原因：${reason}\n\n原文：\n${mailView(store, output).text}`);
}
