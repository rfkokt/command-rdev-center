import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

const pi = process.env.KERN_PI_PATH;
if (!pi)
  throw new Error(
    "KERN_PI_PATH is required; skipped tests do not satisfy B1-06",
  );
const root = resolve(import.meta.dirname, "..");
const extension = resolve(root, "../extensions/browser-tools.ts");
const temp = await mkdtemp(join(tmpdir(), "kern-browser-pi-tools-"));
const socket = join(temp, "host.sock");
const capability = randomBytes(32).toString("hex");
const sessionId = `tools-${process.pid}`;
const host = spawn(process.execPath, [join(root, "host.mjs")], {
  cwd: root,
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? temp,
    KERN_BROWSER_CAPABILITY: capability,
    KERN_BROWSER_SESSION_ID: sessionId,
    KERN_BROWSER_PARENT_PID: String(process.pid),
    KERN_BROWSER_EXPIRES_AT: String(Date.now() + 60_000),
    KERN_BROWSER_ARTIFACT_ROOT: temp,
  },
  stdio: ["pipe", "pipe", "inherit"],
});
const pending = new Map();
createInterface({ input: host.stdout }).on("line", (line) => {
  const value = JSON.parse(line);
  pending.get(value.id)?.(value);
  pending.delete(value.id);
});
function hostCall(frame) {
  host.stdin.write(`${JSON.stringify(frame)}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`host timeout: ${frame.action}`)),
      5_000,
    );
    pending.set(frame.id, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}
const server = createServer((client) => {
  let input = "";
  client.on("data", async (chunk) => {
    input += chunk;
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    const request = JSON.parse(input.slice(0, newline));
    const result = await hostCall(request);
    client.end(`${JSON.stringify({ ...result, id: request.id })}\n`);
  });
});
await new Promise((resolve, reject) =>
  server.listen(socket, resolve).once("error", reject),
);

function launch(extraEnv = {}) {
  return spawn(
    pi,
    [
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--extension",
      extension,
    ],
    {
      cwd: temp,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? temp,
        PI_OFFLINE: "1",
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
}

const project = launch({
  CRC_BROWSER_SOCKET: socket,
  CRC_BROWSER_CAPABILITY: capability,
  CRC_SESSION_ID: sessionId,
  CRC_BROWSER_TOOLS_TEST: "1",
});
const projectEvents = [];
createInterface({ input: project.stdout }).on("line", (line) =>
  projectEvents.push(JSON.parse(line)),
);
project.stdin.write(
  `${JSON.stringify({ type: "prompt", message: "/browser-tools-test" })}\n`,
);
for (
  let i = 0;
  i < 150 &&
  !projectEvents.some((event) =>
    String(event.message).startsWith("browser-tools-test:"),
  );
  i++
)
  await new Promise((resolve) => setTimeout(resolve, 100));
const notification = projectEvents.find((event) =>
  String(event.message).startsWith("browser-tools-test:"),
);
assert.ok(notification, "project pi did not load browser tools extension");
assert.deepEqual(
  JSON.parse(notification.message.slice("browser-tools-test:".length)),
  [
    "browser_open",
    "browser_snapshot",
    "browser_click",
    "browser_fill",
    "browser_wait",
    "browser_network",
    "browser_console",
    "browser_screenshot",
    "browser_close",
  ],
);

const denied = await new Promise((resolve, reject) => {
  const client = createConnection(socket);
  let line = "";
  client.on("connect", () =>
    client.write(
      `${JSON.stringify({ version: 1, id: "bad-cap", sessionId, capability: "0".repeat(64), action: "health", args: {} })}\n`,
    ),
  );
  client.on("data", (chunk) => {
    line += chunk;
    if (line.includes("\n")) resolve(JSON.parse(line));
  });
  client.on("error", reject);
});
assert.equal(denied.error.code, "unauthorized_or_invalid");

project.stdin.write(
  `${JSON.stringify({ type: "prompt", message: "/browser-tools-shutdown-test" })}\n`,
);
for (
  let i = 0;
  i < 100 &&
  !projectEvents.some((event) =>
    String(event.message).startsWith("browser-tools-shutdown-test:"),
  );
  i++
)
  await new Promise((resolve) => setTimeout(resolve, 50));
assert.ok(
  projectEvents.some(
    (event) => event.message === "browser-tools-shutdown-test:ok",
  ),
  "session shutdown cleanup did not close the Chat browser context",
);
project.kill("SIGKILL");

const global = launch({ CRC_BROWSER_TOOLS_TEST: "1" });
const globalEvents = [];
createInterface({ input: global.stdout }).on("line", (line) =>
  globalEvents.push(JSON.parse(line)),
);
global.stdin.write(
  `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
);
for (
  let i = 0;
  i < 100 && !globalEvents.some((event) => event.id === "commands");
  i++
)
  await new Promise((resolve) => setTimeout(resolve, 50));
const commands = globalEvents.find((event) => event.id === "commands");
assert.ok(commands, "global pi did not answer get_commands");
assert.equal(JSON.stringify(commands).includes("browser-tools-test"), false);
global.kill("SIGKILL");
await hostCall({
  version: 1,
  id: "final-shutdown",
  sessionId,
  capability,
  action: "shutdown",
  args: {},
});
await new Promise((resolve) => server.close(resolve));
await rm(temp, { recursive: true, force: true });
console.log(
  "real pi RPC browser tools registration, capability denial, shutdown, and global exclusion passed",
);
process.exit(0);
