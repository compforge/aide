import { execFile } from "node:child_process";
const MEEGLE_TIMEOUT_MS = 20_000;
const MEEGLE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export type MeegleCliRunner = (args: readonly string[]) => Promise<unknown>;
export function defaultMeegleCliRunner(
  args: readonly string[],
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      "meegle",
      [...args],
      {
        encoding: "utf8",
        timeout: MEEGLE_TIMEOUT_MS,
        maxBuffer: MEEGLE_MAX_OUTPUT_BYTES,
      },
      (error, stdout, stderr) => {
        if (error) {
          if ("code" in error && error.code === "ENOENT") {
            reject(
              new Error(
                "Meegle CLI is not installed; run `npx @lark-project/meegle@latest install`",
              ),
            );
            return;
          }
          reject(
            new Error(
              `Meegle CLI failed: ${stderr.trim() || error.message}`,
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout) as unknown);
        } catch (error) {
          if (args[0] === "config" && args[1] === "get") {
            resolve(stdout.trim());
            return;
          }
          const detail = error instanceof Error ? error.message : String(error);
          reject(new Error(`Meegle CLI returned invalid JSON: ${detail}`));
        }
      },
    );
  });
}
