import { AsyncLocalStorage } from "node:async_hooks";

/** Diagnostic correlation only; Host authorization still uses the explicit execution scope. */
export const runnerExecution = new AsyncLocalStorage<string>();
