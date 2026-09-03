#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { chromium } from "playwright";
import { createEnforcingProxy } from "./proxy.mjs";
import {
  ArtifactStore,
  boundedPage,
  sanitizeObservation,
} from "./artifact-store.mjs";
import {
  parseApprovedOrigins,
  requestPolicy,
  validateDestinationUrl,
  validateNavigationUrl,
  validateRequestNetwork,
} from "./network-policy.mjs";
import {
  initializeSemanticSession,
  resolveSemanticTarget,
  SemanticError,
  semanticSnapshot,
} from "./semantic-snapshot.mjs";
import {
  captureScreenshot,
  executeAction,
  resolveActionTarget,
  waitForCondition,
} from "./browser-actions.mjs";

const PROTOCOL = 1;
const capability = process.env.KERN_BROWSER_CAPABILITY;
const boundSessionId = process.env.KERN_BROWSER_SESSION_ID;
const boundParentPid = Number(process.env.KERN_BROWSER_PARENT_PID);
const expiresAt = Number(process.env.KERN_BROWSER_EXPIRES_AT);
const artifactRoot = process.env.KERN_BROWSER_ARTIFACT_ROOT;
const approvedOrigins = parseApprovedOrigins(
  process.env.KERN_BROWSER_APPROVED_ORIGINS,
);
const MAX_FRAME = 1024 * 1024;
const inactivityMs = Math.max(
  100,
  Number(process.env.KERN_BROWSER_INACTIVITY_MS) || 30 * 60_000,
);
if (
  !capability ||
  !/^[0-9a-f]{64}$/.test(capability) ||
  !boundSessionId ||
  boundParentPid !== process.ppid ||
  !Number.isFinite(expiresAt) ||
  !artifactRoot
) {
  process.stderr.write("browser host configuration is invalid\n");
  process.exit(2);
}

const sessions = new Map();
const seen = new Set();
const active = new Map();
let browser;
let proxy;
let closing = false;
let terminal = false;
let lastActivity = Date.now();
const approvals = new Map();
const executionGrants = new Map();
const audit = [];

function reply(id, status, data, error) {
  process.stdout.write(
    `${JSON.stringify({ version: PROTOCOL, id, status, ...(data && { data }), ...(error && { error }) })}\n`,
  );
}

async function context(sessionId) {
  let session = sessions.get(sessionId);
  if (!session) {
    if (!proxy) {
      proxy = createEnforcingProxy({
        token: capability,
        allowLoopback: true,
        allowPublicHttps: process.env.KERN_BROWSER_ALLOW_PUBLIC_HTTPS === "1",
      });
      await proxy.listen();
    }
    browser ??= await chromium.launch({
      headless: process.env.KERN_BROWSER_HEADED !== "1",
      proxy: { server: proxy.url, username: "Bearer", password: capability },
      args: ["--disable-quic", "--proxy-bypass-list=<-loopback>"],
      ...(process.env.KERN_BROWSER_EXECUTABLE && {
        executablePath: process.env.KERN_BROWSER_EXECUTABLE,
      }),
    });
    const browserContext = await browser.newContext({
      serviceWorkers: "block",
    });
    await browserContext.route("**/*", async (route) => {
      const request = route.request();
      try {
        const frame = request.frame();
        const documentOrigin =
          frame.url() && frame.url() !== "about:blank"
            ? new URL(frame.url()).origin
            : undefined;
        requestPolicy({
          url: request.url(),
          method: request.method(),
          navigation: request.isNavigationRequest(),
          topLevel:
            request.isNavigationRequest() && frame === frame.page().mainFrame(),
          documentOrigin,
          approvedOrigins,
        });
        await validateRequestNetwork(request.url(), documentOrigin);
        await route.continue();
      } catch (error) {
        session?.events.network.push({
          disposition: "blocked",
          code: error.message,
        });
        await route.abort("blockedbyclient");
      }
    });
    const page = await browserContext.newPage();
    session = {
      context: browserContext,
      pages: new Map([["main", page]]),
      page,
      events: { console: [], network: [] },
      requestIds: new Set(),
      requestWaiters: new Set(),
      inflight: 0,
      artifacts:
        sessionId === boundSessionId
          ? new ArtifactStore(artifactRoot, sessionId)
          : null,
    };
    page.on("request", (request) => {
      session.inflight += 1;
      const id = request.headers()["x-kern-request-id"];
      if (id) {
        session.requestIds.add(id);
        for (const notify of session.requestWaiters) notify(id);
      }
    });
    const settled = () => { session.inflight = Math.max(0, session.inflight - 1); };
    page.on("requestfinished", settled);
    page.on("requestfailed", settled);
    initializeSemanticSession(session);
    sessions.set(sessionId, session);
  }
  return session;
}

async function smoke(sessionId, args, signal) {
  await validateDestinationUrl(args.url, approvedOrigins);
  const session = await context(sessionId);
  const consoleMessages = [];
  const requests = [];
  session.page.on("console", (message) =>
    consoleMessages.push({
      type: message.type(),
      text: message.text().slice(0, 500),
    }),
  );
  session.page.on("request", (request) =>
    requests.push({
      method: request.method(),
      url: request.url().slice(0, 1000),
    }),
  );
  await session.page.goto(args.url, { waitUntil: "domcontentloaded", signal });
  const snapshot = (await session.page.locator("body").ariaSnapshot()).slice(
    0,
    10_000,
  );
  const screenshot = await session.page.screenshot({ fullPage: true });
  const screenshotArtifact = session.artifacts?.write(
    "screenshots",
    screenshot,
    { contentType: "image/png" },
  );
  return sanitizeObservation({
    source: "untrusted_browser_observation",
    title: await session.page.title(),
    snapshot,
    screenshot: screenshotArtifact,
    console: boundedPage(consoleMessages),
    network: boundedPage(requests),
  });
}

async function isolate(sessionId, args) {
  await validateDestinationUrl(args.url, approvedOrigins);
  const own = await context(sessionId);
  await own.page.goto(args.url);
  await own.context.addCookies([
    { name: "isolation", value: sessionId, url: args.url },
  ]);
  await own.page.evaluate(
    (value) => localStorage.setItem("isolation", value),
    sessionId,
  );
  const otherId = `${sessionId}:other`;
  const other = await context(otherId);
  await other.page.goto(args.url);
  return {
    cookiesIsolated: !(await other.context.cookies()).some(
      (cookie) => cookie.name === "isolation",
    ),
    storageIsolated:
      (await other.page.evaluate(() => localStorage.getItem("isolation"))) ===
      null,
  };
}

function bounded(value, max = 200) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .slice(0, max);
}

function mask(value) {
  const text = String(value ?? "");
  return text
    ? `${"•".repeat(Math.min(text.length, 8))}${text.length > 8 ? "…" : ""}`
    : "";
}

function actionBinding(args) {
  const target = args.target ?? {};
  const normalized = {
    sessionId: boundSessionId,
    action: bounded(args.action, 40),
    targetGeneration: bounded(target.generation, 100),
    role: bounded(target.role, 50),
    name: bounded(target.name),
    origin: new URL(args.origin).origin,
    scope: bounded(args.scope, 200),
    valueHash: createHash("sha256")
      .update(String(args.value ?? ""))
      .digest("hex"),
  };
  return {
    normalized,
    hash: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
  };
}

function classifyAction(args) {
  const action = bounded(args.action, 40);
  if (["snapshot", "console", "network", "screenshot", "wait"].includes(action))
    return "read_only";
  return "approval_required";
}

async function requestApproval(sessionId, args) {
  if (!args?.origin || !args?.action)
    throw new Error("approval_invalid_request");
  const classification = classifyAction(args);
  let executionHash;
  if (["click", "fill"].includes(args.action)) {
    const resolved = await resolveActionTarget(await context(sessionId), args, args.action);
    executionHash = resolved.hash;
    args = { ...args, target: resolved.target };
  }
  if (!args.target?.generation) throw new Error("approval_invalid_request");
  const { normalized, hash } = actionBinding(args);
  if (classification === "read_only") {
    audit.push({
      decision: "allowed_read_only",
      action: normalized.action,
      origin: normalized.origin,
    });
    return { status: "allowed", classification };
  }
  const nonce = randomBytes(32).toString("hex");
  const expiresAt =
    Date.now() +
    Math.min(Math.max(Number(args.ttlMs) || 60_000, 1_000), 5 * 60_000);
  approvals.set(nonce, { hash, executionHash, expiresAt });
  return {
    status: "approval_required",
    nonce,
    preview: {
      origin: normalized.origin,
      currentUrl: bounded(args.currentUrl, 1000),
      action: normalized.action,
      element: {
        role: normalized.role,
        name: normalized.name,
        generation: normalized.targetGeneration,
      },
      surroundingText: bounded(args.surroundingText, 300),
      maskedValue: mask(args.value),
      expectedScope: normalized.scope,
      expiresAt,
    },
  };
}

function resolveApproval(args) {
  const grant = approvals.get(args?.nonce);
  if (!grant) throw new Error("approval_invalid_or_replayed");
  approvals.delete(args.nonce);
  if (args.decision !== "approve") throw new Error("approval_rejected");
  if (Date.now() >= grant.expiresAt) throw new Error("approval_expired");
  const { normalized, hash } = actionBinding(args);
  if (hash !== grant.hash) throw new Error("approval_mismatch");
  const approvalToken = randomBytes(32).toString("hex");
  if (grant.executionHash)
    executionGrants.set(approvalToken, {
      hash: grant.executionHash,
      expiresAt: Math.min(grant.expiresAt, Date.now() + 60_000),
    });
  audit.push({
    decision: "approved",
    action: normalized.action,
    origin: normalized.origin,
  });
  return {
    status: "approved",
    action: normalized.action,
    origin: normalized.origin,
    ...(grant.executionHash && { approvalToken }),
  };
}

async function dispatch(message, signal) {
  if (message.action === "health")
    return { protocol: PROTOCOL, state: "ready" };
  if (message.action === "approval_request")
    return requestApproval(message.sessionId, message.args);
  if (message.action === "approval_resolve")
    return resolveApproval(message.args);
  if (message.action === "approval_audit")
    return { decisions: audit.slice(-100) };
  if (message.action === "open") {
    if (message.args?.url) {
      validateNavigationUrl(message.args.url, approvedOrigins);
      await validateDestinationUrl(message.args.url, approvedOrigins);
    }
    const session = await context(message.sessionId);
    if (message.args?.url)
      await session.page.goto(message.args.url, {
        waitUntil: "domcontentloaded",
        signal,
      });
    return {
      pageId: "main",
      pages: session.pages.size,
      artifactRootReady: Boolean(session.artifacts),
    };
  }
  if (message.action === "snapshot") {
    return semanticSnapshot(
      await context(message.sessionId),
      message.args ?? {},
    );
  }
  if (message.action === "click" || message.action === "fill") {
    const session = await context(message.sessionId);
    return executeAction(session, message.args ?? {}, message.action, (token, hash) => {
      const grant = executionGrants.get(token);
      if (!grant) return false;
      executionGrants.delete(token);
      return Date.now() < grant.expiresAt && grant.hash === hash;
    });
  }
  if (message.action === "wait")
    return waitForCondition(await context(message.sessionId), message.args ?? {}, signal);
  if (message.action === "screenshot")
    return captureScreenshot(await context(message.sessionId), message.args ?? {});
  if (message.action === "resolve_target") {
    const target = await resolveSemanticTarget(
      await context(message.sessionId),
      message.args ?? {},
    );
    return {
      resolved: true,
      role: await target.getAttribute("role"),
      tagName: await target.evaluate((element) =>
        element.tagName.toLowerCase(),
      ),
    };
  }
  if (message.action === "close") {
    const session = sessions.get(message.sessionId);
    if (session) await session.context.close();
    sessions.delete(message.sessionId);
    approvals.clear();
    executionGrants.clear();
    terminal = true;
    return { closed: true };
  }
  if (message.action === "smoke")
    return smoke(message.sessionId, message.args ?? {}, signal);
  if (message.action === "isolate")
    return isolate(message.sessionId, message.args ?? {});
  if (message.action === "sleep") {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        resolve,
        Math.min(Number(message.args?.ms) || 0, 30_000),
      );
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("cancelled", "AbortError"));
        },
        { once: true },
      );
    });
    return { completed: true };
  }
  throw new Error("unknown_action");
}

async function close() {
  if (closing) return;
  closing = true;
  for (const controller of active.values()) controller.abort();
  active.clear();
  await Promise.allSettled(
    [...sessions.values()].map((session) => session.context.close()),
  );
  sessions.clear();
  await browser?.close();
  browser = undefined;
  await proxy?.close();
  proxy = undefined;
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (Buffer.byteLength(line) > MAX_FRAME)
    return reply(null, "error", null, { code: "frame_too_large" });
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return reply(null, "error", null, { code: "malformed_json" });
  }
  const { id } = message;
  if (closing)
    return reply(id, "error", null, { code: "closing", retryable: false });
  if (terminal)
    return reply(id, "error", null, {
      code: "capability_closed",
      retryable: false,
    });
  if (Date.now() >= expiresAt)
    return reply(id, "error", null, {
      code: "capability_expired",
      retryable: false,
    });
  if (
    message.version !== PROTOCOL ||
    message.capability !== capability ||
    message.sessionId !== boundSessionId ||
    typeof id !== "string" ||
    !id ||
    typeof message.action !== "string" ||
    (message.args != null &&
      (typeof message.args !== "object" || Array.isArray(message.args)))
  ) {
    return reply(id ?? null, "error", null, {
      code: "unauthorized_or_invalid",
      retryable: false,
    });
  }
  const replayKey = `${message.sessionId}:${id}`;
  if (seen.has(replayKey))
    return reply(id, "error", null, {
      code: "replayed_request",
      retryable: false,
    });
  seen.add(replayKey);
  lastActivity = Date.now();
  if (message.action === "cancel") {
    const target = active.get(message.args?.requestId);
    if (target) target.abort();
    return reply(id, "ok", { cancelled: Boolean(target) });
  }
  if (message.action === "shutdown") {
    await close();
    reply(id, "ok", { closed: true });
    return input.close();
  }
  const controller = new AbortController();
  active.set(id, controller);
  try {
    reply(id, "ok", await dispatch(message, controller.signal));
  } catch (error) {
    reply(id, error?.name === "AbortError" ? "cancelled" : "error", null, {
      code:
        error instanceof SemanticError
          ? error.code
          : error?.message || "host_error",
      message:
        error instanceof SemanticError
          ? error.code
          : error?.message || "host_error",
      retryable: error instanceof SemanticError ? error.retryable : false,
    });
  } finally {
    active.delete(id);
  }
});
input.on("close", async () => {
  await close();
  process.exit(0);
});
const inactivityTimer = setInterval(
  async () => {
    if (!closing && Date.now() - lastActivity >= inactivityMs) {
      terminal = true; // revoke before teardown
      await close();
      input.close();
    }
  },
  Math.min(1_000, Math.max(50, Math.floor(inactivityMs / 4))),
);
inactivityTimer.unref();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    terminal = true;
    await close();
    process.exit(0);
  });
