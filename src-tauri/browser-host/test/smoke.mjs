import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { fixture } from "./fixture.mjs";

const app = await fixture();
const capability = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "").slice(0, 64);
const started = performance.now();
const child = spawn(process.execPath, [fileURLToPath(new URL("../host.mjs", import.meta.url))], {
  env: {
    ...process.env,
    KERN_BROWSER_CAPABILITY: capability,
    KERN_BROWSER_SESSION_ID: "smoke-chat",
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "0",
    ...(process.env.KERN_BROWSER_EXECUTABLE && { KERN_BROWSER_EXECUTABLE: process.env.KERN_BROWSER_EXECUTABLE }),
  },
  stdio: ["pipe", "pipe", "inherit"],
});
const pending = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  const value = JSON.parse(line);
  pending.get(value.id)?.(value);
});
const call = (id, action, args) => new Promise((resolve) => {
  pending.set(id, resolve);
  child.stdin.write(`${JSON.stringify({ version: 1, capability, sessionId: "smoke-chat", id, action, args })}\n`);
});
const health = await call("health", "health");
const isolation = await call("isolation", "isolate", { url: app.url });
const smoke = await call("smoke", "smoke", { url: app.url });
const shutdown = await call("shutdown", "shutdown");
await new Promise((resolve) => child.once("exit", resolve));
await app.close();
console.log(JSON.stringify({ health, isolation, smoke, shutdown, elapsedMs: Math.round(performance.now() - started) }, null, 2));
