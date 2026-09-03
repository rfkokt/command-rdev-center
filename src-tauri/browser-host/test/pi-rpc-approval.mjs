import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

const pi = process.env.KERN_PI_PATH;
if (!pi)
  throw new Error(
    "KERN_PI_PATH is required; skipped tests do not satisfy B1-04",
  );
const root = resolve(import.meta.dirname, "..");
const extension = resolve(root, "../extensions/browser-tools.ts");
const temp = await mkdtemp(join(tmpdir(), "kern-browser-pi-rpc-"));
const socket = join(temp, "host.sock");
const capability = randomBytes(32).toString("hex");
const sessionId = `approval-${process.pid}`;
const expires = String(Date.now() + 60_000);
const host = spawn(process.execPath, [join(root, "host.mjs")], {
  cwd: root,
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? temp,
    KERN_BROWSER_CAPABILITY: capability,
    KERN_BROWSER_SESSION_ID: sessionId,
    KERN_BROWSER_PARENT_PID: String(process.pid),
    KERN_BROWSER_EXPIRES_AT: expires,
    KERN_BROWSER_ARTIFACT_ROOT: temp,
  },
  stdio: ["pipe", "pipe", "inherit"],
});
let hostId = 0;
const pending = new Map();
createInterface({ input: host.stdout }).on("line", (line) => {
  const value = JSON.parse(line);
  pending.get(value.id)?.(value);
  pending.delete(value.id);
});
function hostCall(action, args) {
  const id = `h-${++hostId}`;
  host.stdin.write(
    `${JSON.stringify({ version: 1, id, sessionId, capability, action, args })}\n`,
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`host timeout: ${action}`)),
      5_000,
    );
    pending.set(id, (value) => {
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
    const result = await hostCall(request.action, request.args);
    client.end(`${JSON.stringify({ ...result, id: request.id })}\n`);
  });
});
await new Promise((resolve, reject) =>
  server.listen(socket, resolve).once("error", reject),
);

const child = spawn(
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
      CRC_BROWSER_SOCKET: socket,
      CRC_BROWSER_CAPABILITY: capability,
      CRC_SESSION_ID: sessionId,
      CRC_BROWSER_APPROVAL_TEST: "1",
      PI_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "inherit"],
  },
);
const events = [];
let notify;
createInterface({ input: child.stdout }).on("line", (line) => {
  const event = JSON.parse(line);
  events.push(event);
  if (event.type === "extension_ui_request" && event.method === "confirm") {
    child.stdin.write(
      `${JSON.stringify({ type: "extension_ui_response", id: event.id, confirmed: true })}\n`,
    );
  }
  if (
    event.type === "extension_ui_request" &&
    event.method === "notify" &&
    String(event.message).startsWith("browser-approval-test:")
  )
    notify?.(event);
});
child.stdin.write(
  `${JSON.stringify({ type: "prompt", message: "/browser-approval-test" })}\n`,
);
const resultEvent = await new Promise((resolve, reject) => {
  notify = resolve;
  setTimeout(
    () => reject(new Error("pi approval round trip timed out")),
    15_000,
  );
});
const result = JSON.parse(
  resultEvent.message.slice("browser-approval-test:".length),
);
assert.equal(result.status, "ok");
assert.equal(result.data.status, "approved");
assert.ok(
  events.some(
    (event) =>
      event.type === "extension_ui_request" && event.method === "confirm",
  ),
);
const audit = await hostCall("approval_audit", {});
assert.equal(audit.data.decisions.at(-1).decision, "approved");
child.kill("SIGTERM");
await hostCall("shutdown", {});
server.close();
await rm(temp, { recursive: true, force: true });
console.log("real pi RPC approval round trip passed");
