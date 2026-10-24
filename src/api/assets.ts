import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Asset { type: string; content: string | Buffer }

/** Fixed routes only: request paths never become filesystem paths. */
export function createWebAssets() {
  const pages = [
    { route: "/", directory: "topics", bundle: "/app" },
    { route: "/people", directory: "persons", bundle: "/persons" },
    { route: "/inputs", directory: "inputs", bundle: "/inputs" },
    { route: "/connections", directory: "connections", bundle: "/connections" },
  ];
  const files = new Map<string, Asset>();
  for (const [route, file, type] of [
    ["/icon.png", "aide.png", "image/png"],
    ["/favicon.ico", "favicon.ico", "image/vnd.microsoft.icon"],
    ["/apple-touch-icon.png", "apple-touch-icon.png", "image/png"],
  ] as const) files.set(route, {
    type, content: readFileSync(new URL(`../web/assets/${file}`, import.meta.url)),
  });
  const builds = new Map<string, Promise<void>>();
  for (const page of pages) files.set(page.route, {
    type: "text/html", content: readFileSync(new URL(`../web/${page.directory}/index.html`, import.meta.url), "utf8"),
  });
  return async (path: string): Promise<Asset | undefined> => {
    if (files.has(path)) return files.get(path);
    const page = pages.find((page) => path === page.bundle + ".js" || path === page.bundle + ".css");
    if (!page) return undefined;
    let build = builds.get(page.directory);
    if (!build) {
      build = (async () => {
        const result = await Bun.build({
          entrypoints: [fileURLToPath(new URL(`../web/${page.directory}/main.ts`, import.meta.url))],
          target: "browser", format: "esm", minify: true,
        });
        if (!result.success) throw new AggregateError(result.logs, `${page.directory} browser build failed`);
        for (const output of result.outputs) {
          const css = output.path.endsWith(".css");
          files.set(page.bundle + (css ? ".css" : ".js"), {
            type: css ? "text/css" : "text/javascript", content: await output.text(),
          });
        }
      })().catch((error: unknown) => { builds.delete(page.directory); throw error; });
      builds.set(page.directory, build);
    }
    await build;
    return files.get(path);
  };
}
