import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fixture } from "./fixture.mjs";

const capability =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const exit = (child) =>
  child.exitCode === null
    ? once(child, "exit").then(([code]) => code)
    : Promise.resolve(child.exitCode);

function host(approvedOrigins = "", extraEnv = {}) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../host.mjs", import.meta.url))],
    {
      env: {
        ...process.env,
        KERN_BROWSER_CAPABILITY: capability,
        KERN_BROWSER_SESSION_ID: "chat-a",
        KERN_BROWSER_PARENT_PID: String(process.pid),
        KERN_BROWSER_EXPIRES_AT: String(Date.now() + 60_000),
        KERN_BROWSER_ARTIFACT_ROOT: "/tmp/sessions/chat-a/browser",
        KERN_BROWSER_APPROVED_ORIGINS: approvedOrigins,
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "0",
        ...(process.env.KERN_BROWSER_EXECUTABLE && {
          KERN_BROWSER_EXECUTABLE: process.env.KERN_BROWSER_EXECUTABLE,
        }),
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const responses = [];
  createInterface({ input: child.stdout }).on("line", (line) =>
    responses.push(JSON.parse(line)),
  );
  const send = (message) =>
    child.stdin.write(
      `${JSON.stringify({ version: 1, capability, sessionId: "chat-a", ...message })}\n`,
    );
  const raw = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const wait = async (id, occurrence = 0) => {
    for (let i = 0; i < 3_000; i++) {
      const response = responses.filter((item) => item.id === id)[occurrence];
      if (response) return response;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timeout waiting for ${id}`);
  };
  return { child, send, raw, wait };
}

test("health, replay defense, cancellation and idempotent shutdown", async () => {
  const instance = host();
  instance.send({ id: "health", action: "health" });
  assert.equal((await instance.wait("health")).data.state, "ready");
  instance.send({ id: "health", action: "health" });
  assert.equal(
    (await instance.wait("health", 1)).error.code,
    "replayed_request",
  );
  instance.raw({
    version: 1,
    capability: "0".repeat(64),
    sessionId: "chat-a",
    id: "wrong-capability",
    action: "health",
  });
  assert.equal(
    (await instance.wait("wrong-capability")).error.code,
    "unauthorized_or_invalid",
  );
  instance.raw({
    version: 1,
    capability,
    sessionId: "chat-b",
    id: "cross-session",
    action: "health",
  });
  assert.equal(
    (await instance.wait("cross-session")).error.code,
    "unauthorized_or_invalid",
  );
  instance.raw({
    version: 1,
    capability,
    sessionId: "chat-a",
    id: "malformed-envelope",
    action: 42,
    args: [],
  });
  assert.equal(
    (await instance.wait("malformed-envelope")).error.code,
    "unauthorized_or_invalid",
  );
  instance.send({ id: "sleep", action: "sleep", args: { ms: 5_000 } });
  instance.send({
    id: "cancel",
    action: "cancel",
    args: { requestId: "sleep" },
  });
  assert.equal((await instance.wait("cancel")).data.cancelled, true);
  assert.equal((await instance.wait("sleep")).status, "cancelled");
  instance.send({ id: "shutdown", action: "shutdown" });
  assert.equal((await instance.wait("shutdown")).data.closed, true);
  assert.equal(await exit(instance.child), 0);
});

test("capability expiry fails closed", async () => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../host.mjs", import.meta.url))],
    {
      env: {
        ...process.env,
        KERN_BROWSER_CAPABILITY: capability,
        KERN_BROWSER_SESSION_ID: "chat-a",
        KERN_BROWSER_PARENT_PID: String(process.pid),
        KERN_BROWSER_EXPIRES_AT: String(Date.now() - 1),
        KERN_BROWSER_ARTIFACT_ROOT: "/tmp/kern-browser-test-expired",
      },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const lines = createInterface({ input: child.stdout });
  child.stdin.write(
    `${JSON.stringify({ version: 1, capability, sessionId: "chat-a", id: "expired", action: "health", args: {} })}\n`,
  );
  const [line] = await once(lines, "line");
  assert.equal(JSON.parse(line).error.code, "capability_expired");
  child.stdin.end();
  assert.equal(await exit(child), 0);
});

test("packaged runtime primitives isolate contexts and capture evidence", async (t) => {
  const app = await fixture();
  t.after(app.close);
  const instance = host(new URL(app.url).origin);
  t.after(() => {
    if (instance.child.exitCode === null) instance.child.kill("SIGKILL");
  });
  instance.send({ id: "open", action: "open", args: {} });
  assert.deepEqual(await instance.wait("open"), {
    version: 1,
    id: "open",
    status: "ok",
    data: { pageId: "main", pages: 1, artifactRootReady: true },
  });
  instance.send({ id: "isolate", action: "isolate", args: { url: app.url } });
  const isolated = await instance.wait("isolate");
  assert.equal(isolated.status, "ok", JSON.stringify(isolated));
  assert.deepEqual(isolated.data, {
    cookiesIsolated: true,
    storageIsolated: true,
  });
  instance.send({ id: "smoke", action: "smoke", args: { url: app.url } });
  const result = await instance.wait("smoke");
  assert.equal(result.status, "ok");
  assert.match(result.data.snapshot, /heading "Ready"/);
  assert.match(result.data.screenshot.artifactRef, /^browser-artifact:chat-a:/);
  assert.equal(result.data.screenshot.modelAttachment, false);
  assert.ok(
    result.data.console.data.some(
      (entry) => entry.text === "fixture-console-proof",
    ),
  );
  assert.ok(
    result.data.network.data.some((entry) => entry.url.endsWith("/evidence")),
  );
  instance.send({ id: "close", action: "close" });
  assert.equal((await instance.wait("close")).data.closed, true);
  instance.send({
    id: "open-after-close",
    action: "open",
    args: { url: app.url },
  });
  assert.equal(
    (await instance.wait("open-after-close")).error.code,
    "capability_closed",
  );
  instance.child.stdin.end();
  assert.equal(await exit(instance.child), 0);
});

test("semantic snapshot issues bounded refs and resolves locators safely", async (t) => {
  const app = await fixture();
  t.after(app.close);
  const instance = host(new URL(app.url).origin);
  t.after(() => {
    if (instance.child.exitCode === null) instance.child.kill("SIGKILL");
  });
  instance.send({
    id: "open-semantic",
    action: "open",
    args: { url: app.url },
  });
  assert.equal((await instance.wait("open-semantic")).status, "ok");
  instance.send({
    id: "snapshot",
    action: "snapshot",
    args: { maxChars: 1_000 },
  });
  const snapshot = await instance.wait("snapshot");
  assert.equal(snapshot.status, "ok", JSON.stringify(snapshot));
  assert.match(snapshot.data.snapshot, /UNTRUSTED BROWSER OBSERVATION/);
  assert.match(snapshot.data.snapshot, /textbox "Name"/);
  assert.match(snapshot.data.snapshot, /value="Ada"/);
  assert.match(snapshot.data.snapshot, /\[secret control\]/);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /never-visible|secret-token|Hidden secret/,
  );
  const ref = snapshot.data.snapshot.match(
    /textbox "Name" \[ref=(element:[0-9a-f]+)\]/,
  )?.[1];
  assert.ok(ref);

  const modes = [
    ["role", { role: "button", name: "Verify" }],
    ["label", { label: "Name" }],
    ["placeholder", { placeholder: "work@example.com" }],
    ["text", { text: "Visible proof text" }],
    ["selector", { selector: "button:not([disabled]):not(.duplicate)" }],
    ["ref", { ref }],
  ];
  for (const [name, args] of modes) {
    instance.send({ id: `resolve-${name}`, action: "resolve_target", args });
    assert.equal((await instance.wait(`resolve-${name}`)).status, "ok", name);
  }
  instance.send({
    id: "ambiguous",
    action: "resolve_target",
    args: { selector: ".duplicate" },
  });
  assert.equal(
    (await instance.wait("ambiguous")).error.code,
    "target_ambiguous",
  );
  instance.send({
    id: "missing",
    action: "resolve_target",
    args: { text: "Absent" },
  });
  assert.equal((await instance.wait("missing")).error.code, "target_not_found");
  instance.send({
    id: "disabled",
    action: "resolve_target",
    args: { role: "button", name: "Disabled action" },
  });
  assert.equal((await instance.wait("disabled")).error.code, "target_disabled");
  instance.send({
    id: "secret",
    action: "resolve_target",
    args: { label: "Password" },
  });
  assert.equal(
    (await instance.wait("secret")).error.code,
    "target_policy_blocked",
  );

  instance.send({
    id: "snapshot-page",
    action: "snapshot",
    args: { maxChars: 1_000, cursor: 100 },
  });
  const page = await instance.wait("snapshot-page");
  assert.equal(page.data.cursor, 100);
  assert.ok(page.data.snapshot.length <= 1_000);

  instance.send({
    id: "navigate",
    action: "open",
    args: { url: `${app.url}?next=1` },
  });
  assert.equal((await instance.wait("navigate")).status, "ok");
  instance.send({ id: "stale", action: "resolve_target", args: { ref } });
  assert.equal((await instance.wait("stale")).error.code, "stale_element_ref");
  instance.send({ id: "shutdown-semantic", action: "shutdown" });
  await instance.wait("shutdown-semantic");
  assert.equal(await exit(instance.child), 0);
});

test("safe actions require exact approval, reject secrets, wait explicitly, and store screenshots", async (t) => {
  const app = await fixture();
  t.after(app.close);
  const instance = host(new URL(app.url).origin);
  t.after(() => instance.child.exitCode === null && instance.child.kill("SIGKILL"));
  instance.send({ id: "open-actions", action: "open", args: { url: app.url } });
  assert.equal((await instance.wait("open-actions")).status, "ok");

  const approveAndRun = async (id, action, args) => {
    const currentUrl = app.url;
    instance.send({ id: `${id}-approval`, action: "approval_request", args: { ...args, action, origin: new URL(app.url).origin, currentUrl } });
    const pending = await instance.wait(`${id}-approval`);
    assert.equal(pending.data.status, "approval_required");
    instance.send({ id: `${id}-resolve`, action: "approval_resolve", args: { ...args, action, origin: new URL(app.url).origin, currentUrl, target: pending.data.preview.element, nonce: pending.data.nonce, decision: "approve" } });
    const resolved = await instance.wait(`${id}-resolve`);
    assert.equal(resolved.status, "ok", JSON.stringify(resolved));
    instance.send({ id, action, args: { ...args, approvalToken: resolved.data.approvalToken } });
    return instance.wait(id);
  };

  instance.send({ id: "unapproved", action: "fill", args: { label: "Name", value: "Grace" } });
  assert.equal((await instance.wait("unapproved")).error.code, "approval_required");
  assert.equal((await approveAndRun("fill-name", "fill", { label: "Name", value: "Grace" })).status, "ok");

  for (const [id, args] of [
    ["password", { label: "Password", value: "safe-looking" }],
    ["otp", { label: "OTP", value: "123456" }],
    ["card", { label: "Card number", value: "4111111111111111" }],
    ["passkey", { label: "Passkey", value: "credential" }],
    ["api-key", { label: "Name", value: "api_key=abcd1234" }],
  ]) {
    instance.send({ id, action: "approval_request", args: { ...args, action: "fill", origin: new URL(app.url).origin, currentUrl: app.url } });
    assert.match((await instance.wait(id)).error.code, /secret|target_policy_blocked/);
  }

  instance.send({ id: "wait-text", action: "wait", args: { text: "Late proof", timeout: 2_000 } });
  assert.deepEqual((await instance.wait("wait-text")).data, { condition: "text", actual: "Late proof" });
  instance.send({ id: "wait-request", action: "wait", args: { requestId: "evidence-1", timeout: 500 } });
  assert.equal((await instance.wait("wait-request")).data.condition, "requestId");
  instance.send({ id: "wait-quiet", action: "wait", args: { networkQuietMs: 100, timeout: 2_000 } });
  assert.deepEqual((await instance.wait("wait-quiet")).data, { condition: "networkQuiet", quietMs: 100, readiness: "observation_only" });
  instance.send({ id: "wait-timeout", action: "wait", args: { text: "Never appears", timeout: 50 } });
  assert.equal((await instance.wait("wait-timeout")).error.code, "wait_timeout");

  instance.send({ id: "screen-page", action: "screenshot", args: { name: "before-submit", fullPage: true } });
  assert.match((await instance.wait("screen-page")).data.artifactRef, /^browser-artifact:chat-a:/);
  instance.send({ id: "screen-element", action: "screenshot", args: { name: "field", selector: "input[aria-label=Name]" } });
  assert.match((await instance.wait("screen-element")).data.artifactRef, /^browser-artifact:chat-a:/);
  instance.send({ id: "screen-path", action: "screenshot", args: { name: "../escape" } });
  assert.equal((await instance.wait("screen-path")).error.code, "screenshot_name_invalid");

  const clicked = await approveAndRun("submit", "click", { role: "button", name: "Verify" });
  assert.equal(clicked.status, "ok", JSON.stringify(clicked));
  instance.send({ id: "wait-url", action: "wait", args: { url: `${app.url}/submit`, timeout: 2_000 } });
  assert.equal((await instance.wait("wait-url")).data.condition, "url");
  instance.send({ id: "shutdown-actions", action: "shutdown" });
  await instance.wait("shutdown-actions");
  assert.equal(await exit(instance.child), 0);
});

test("wait cancellation returns cancelled", async (t) => {
  const app = await fixture();
  t.after(app.close);
  const instance = host(new URL(app.url).origin);
  instance.send({ id: "open-cancel", action: "open", args: { url: app.url } });
  await instance.wait("open-cancel");
  instance.send({ id: "waiting", action: "wait", args: { text: "Never appears", timeout: 10_000 } });
  instance.send({ id: "cancel-wait", action: "cancel", args: { requestId: "waiting" } });
  assert.equal((await instance.wait("cancel-wait")).data.cancelled, true);
  assert.equal((await instance.wait("waiting")).status, "cancelled");
  instance.send({ id: "shutdown-cancel", action: "shutdown" });
  await instance.wait("shutdown-cancel");
});

test("inactivity independently revokes capability and exits", async () => {
  const instance = host("", { KERN_BROWSER_INACTIVITY_MS: "150" });
  instance.send({ id: "health", action: "health" });
  assert.equal((await instance.wait("health")).status, "ok");
  assert.equal(await exit(instance.child), 0);
});

test("action approvals are exact, masked, one-shot, expiring, and fail closed", async () => {
  const instance = host();
  const action = {
    action: "fill",
    origin: "https://staging.example.com",
    currentUrl: "https://staging.example.com/form",
    target: { generation: "element-7:v3", role: "textbox", name: "Email" },
    surroundingText: "Account email address",
    value: "private@example.com",
    scope: "POST /accounts/test-123",
    ttlMs: 1_000,
  };
  instance.send({ id: "request", action: "approval_request", args: action });
  const requested = await instance.wait("request");
  assert.equal(requested.data.status, "approval_required");
  assert.equal(requested.data.preview.maskedValue.includes("private"), false);
  assert.equal(
    JSON.stringify(requested).includes("private@example.com"),
    false,
  );

  instance.send({
    id: "mismatch",
    action: "approval_resolve",
    args: {
      ...action,
      nonce: requested.data.nonce,
      decision: "approve",
      value: "changed",
    },
  });
  assert.equal(
    (await instance.wait("mismatch")).error.code,
    "approval_mismatch",
  );
  instance.send({
    id: "replay",
    action: "approval_resolve",
    args: { ...action, nonce: requested.data.nonce, decision: "approve" },
  });
  assert.equal(
    (await instance.wait("replay")).error.code,
    "approval_invalid_or_replayed",
  );

  instance.send({ id: "request-2", action: "approval_request", args: action });
  const second = await instance.wait("request-2");
  instance.send({
    id: "approve",
    action: "approval_resolve",
    args: { ...action, nonce: second.data.nonce, decision: "approve" },
  });
  assert.equal((await instance.wait("approve")).data.status, "approved");
  instance.send({
    id: "replay-2",
    action: "approval_resolve",
    args: { ...action, nonce: second.data.nonce, decision: "approve" },
  });
  assert.equal(
    (await instance.wait("replay-2")).error.code,
    "approval_invalid_or_replayed",
  );

  instance.send({ id: "request-3", action: "approval_request", args: action });
  const third = await instance.wait("request-3");
  instance.send({
    id: "reject",
    action: "approval_resolve",
    args: { ...action, nonce: third.data.nonce, decision: "reject" },
  });
  assert.equal((await instance.wait("reject")).error.code, "approval_rejected");

  instance.send({
    id: "read",
    action: "approval_request",
    args: { ...action, action: "snapshot" },
  });
  assert.equal((await instance.wait("read")).data.status, "allowed");
  instance.send({ id: "audit", action: "approval_audit" });
  const audit = await instance.wait("audit");
  assert.equal(JSON.stringify(audit).includes("private@example.com"), false);
  instance.send({ id: "shutdown", action: "shutdown" });
  await instance.wait("shutdown");
  assert.equal(await exit(instance.child), 0);
});
