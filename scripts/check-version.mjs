import { readFileSync } from "node:fs";

const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const tauriVersion = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
const cargoVersion = readFileSync("src-tauri/Cargo.toml", "utf8").match(/^version = "([^"]+)"/m)?.[1];
const lockVersion = readFileSync("src-tauri/Cargo.lock", "utf8").match(/name = "command-rdev-center"\nversion = "([^"]+)"/)?.[1];
const versions = { package: packageVersion, tauri: tauriVersion, cargo: cargoVersion, lock: lockVersion };

if (new Set(Object.values(versions)).size !== 1) {
  console.error("Version mismatch:", versions);
  process.exit(1);
}

console.log(`Version synchronized: ${packageVersion}`);
