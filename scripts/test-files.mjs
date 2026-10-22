import { statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const selected = (process.env.TEST_FILES ?? "").trim().split(/\s+/).filter(Boolean);
// A misspelled selection must fail, never silently run zero tests or a wider pattern.
const files = selected.map(file => {
  const absolute = resolve(root, file);
  const path = relative(root, absolute);
  if (isAbsolute(file) || path === ".." || path.startsWith(`..${sep}`) ||
      !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || !statSync(absolute).isFile()) {
    throw new Error(`TEST_FILES must contain repository-relative test files: ${file}`);
  }
  return `./${path}`;
});
const result = spawnSync(resolve(root, "node_modules/.bin/bun"), ["test", ...(files.length ? files : ["tests"])], {
  cwd: root, stdio: "inherit", env: process.env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
