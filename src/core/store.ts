import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MessageSchema, WorkSchema, type Message, type Work } from "./model.ts";

const StateSchema = z.object({
  version: z.literal(1), works: z.array(WorkSchema), messages: z.array(MessageSchema),
  inputs: z.array(z.object({ key: z.string(), responseId: z.string() })),
  events: z.array(z.string()),
});
type State = z.infer<typeof StateSchema>;

/**
 * @spec One process owns a data directory; work transitions and outgoing messages commit together.
 * @why A single atomic JSON snapshot keeps the prototype inspectable without a database service.
 */
export class Store {
  private state: State;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    try {
      this.state = StateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { version: 1, works: [], messages: [], inputs: [], events: [] };
    }
  }

  read(): State { return structuredClone(this.state); }

  update<T>(change: (state: State) => T): T {
    const next = structuredClone(this.state);
    const result = change(next);
    StateSchema.parse(next);
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(temporary, this.path);
    this.state = next;
    return structuredClone(result);
  }
}

export function message(conversationId: string, text: string, workId: string | null = null): Message {
  return { id: randomUUID(), conversationId, text, workId, at: new Date().toISOString(), role: "aide" };
}

export function findWork(state: State, id: string): Work {
  const work = state.works.find((item) => item.id === id);
  if (!work) throw new Error(`Unknown work ${id}`);
  return work;
}
