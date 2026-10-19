import type { ControllerSource } from "@compforge/aide-plugin";
import { nextCronSourceAt } from "./cron-source.ts";

export function validateSources<TSpec>(
  sources: readonly ControllerSource<TSpec>[] | undefined,
  currentDate: Date,
): void {
  if (!sources) return;
  const ids = new Set<string>();
  for (const source of sources) {
    if (!source.sourceId.trim()) {
      throw new Error("Controller sourceId must not be empty");
    }
    if (ids.has(source.sourceId)) {
      throw new Error(
        `Controller sourceId already registered: ${source.sourceId}`,
      );
    }
    ids.add(source.sourceId);
    if (source.type === "resource") {
      if (typeof source.start !== "function") {
        throw new Error(
          `Controller resource Source ${source.sourceId} must provide start()`,
        );
      }
      continue;
    }
    if (!source.cron.trim()) {
      throw new Error(
        `Controller cron Source ${source.sourceId} cron must not be empty`,
      );
    }
    if (!source.timeZone.trim()) {
      throw new Error(
        `Controller cron Source ${source.sourceId} timeZone must not be empty`,
      );
    }
    nextCronSourceAt(source, currentDate);
  }
}

