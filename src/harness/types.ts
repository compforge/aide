export interface StructuredRequest {
  prompt: string;
  jsonSchema: Record<string, unknown>;
  cwd: string;
  model?: string;
  timeoutMs?: number;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  signal?: AbortSignal;
}

/** Aide owns work context; a Harness owns one bounded execution. */
export interface Harness {
  generate(request: StructuredRequest): Promise<unknown>;
}
