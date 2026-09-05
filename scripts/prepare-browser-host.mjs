import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const host = fileURLToPath(
  new URL("../src-tauri/browser-host/", import.meta.url),
);
const browsers = resolve(host, ".browsers");
// Tauri bundles these exact paths; resolving a hoisted package is not enough.
if (
  ["playwright", "playwright-core"].some(
    (name) => !existsSync(resolve(host, "node_modules", name, "package.json")),
  )
) {
  execFileSync("npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: host,
    stdio: "inherit",
  });
}
execFileSync(
  process.execPath,
  [resolve(host, "node_modules/playwright/cli.js"), "install", "chromium"],
  {
    cwd: host,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
    stdio: "inherit",
  },
);
const target = resolve(host, "runtime/node-aarch64-apple-darwin");
mkdirSync(dirname(target), { recursive: true });
mkdirSync(browsers, { recursive: true });
copyFileSync(process.execPath, target);
