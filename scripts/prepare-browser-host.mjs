import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const target = resolve(
  "src-tauri/browser-host/runtime/node-aarch64-apple-darwin",
);
mkdirSync(dirname(target), { recursive: true });
mkdirSync(resolve("src-tauri/browser-host/.browsers"), { recursive: true });
copyFileSync(process.execPath, target);
