import { createHash } from "node:crypto";
import { SemanticError, resolveSemanticTarget } from "./semantic-snapshot.mjs";

const SECRET_VALUE = /(?:password|passcode|otp|one[-_ ]?time|api[-_ ]?key|access[-_ ]?token|secret|bearer\s+[a-z0-9._~+\/-]{8,}|(?:credit|debit)[-_ ]?card|card[-_ ]?number|cvv|cvc|passkey|private[-_ ]?key)\s*[:=]?\s*\S{4,}/i;
const SECRET_CONTROL = /password|passcode|otp|one[-_ ]?time|api[-_ ]?key|token|secret|credit|debit|card|cvv|cvc|payment|passkey|webauthn|pin/i;
export const DEFAULT_TIMEOUT = 10_000;
export const MAX_TIMEOUT = 60_000;

export function boundedTimeout(value) {
  const timeout = value == null ? DEFAULT_TIMEOUT : Number(value);
  if (!Number.isFinite(timeout) || timeout < 1) throw new Error("wait_invalid_timeout");
  return Math.min(timeout, MAX_TIMEOUT);
}

export function actionHash(action, target, value = "") {
  return createHash("sha256")
    .update(JSON.stringify({ action, target, value }))
    .digest("hex");
}

async function targetMetadata(locator, generation) {
  return locator.evaluate((element, generation) => ({
    generation,
    tag: element.tagName.toLowerCase(),
    type: (element.getAttribute("type") || "").toLowerCase(),
    role: element.getAttribute("role") || undefined,
    name: element.getAttribute("aria-label") || element.labels?.[0]?.textContent?.trim() || element.textContent?.trim().slice(0, 300) || "",
    identity: [element.id, element.getAttribute("name"), element.getAttribute("autocomplete"), element.getAttribute("aria-label"), element.getAttribute("placeholder")].filter(Boolean).join(" "),
  }), generation);
}

export async function resolveActionTarget(session, args, action) {
  const locator = await resolveSemanticTarget(session, args);
  const target = await targetMetadata(locator, session.semantic.generation);
  if (action === "fill") {
    if (target.type === "password" || SECRET_CONTROL.test(`${target.identity} ${target.name}`))
      throw new SemanticError("secret_control_blocked");
    if (SECRET_VALUE.test(String(args.value ?? "")))
      throw new SemanticError("secret_value_blocked");
  }
  return { locator, target, hash: actionHash(action, target, action === "fill" ? String(args.value ?? "") : "") };
}

export async function executeAction(session, args, action, consumeGrant) {
  const resolved = await resolveActionTarget(session, args, action);
  if (!consumeGrant(args.approvalToken, resolved.hash))
    throw new SemanticError("approval_required");
  // Resolve and classify again immediately before execution to close target-change TOCTOU.
  const current = await resolveActionTarget(session, args, action);
  if (current.hash !== resolved.hash) throw new SemanticError("approval_mismatch");
  if (action === "click") await current.locator.click();
  else await current.locator.fill(String(args.value ?? ""));
  return { action, target: current.target, url: session.page.url() };
}

function abortPromise(signal) {
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
}

export async function waitForCondition(session, args, signal) {
  const timeout = boundedTimeout(args.timeout);
  const requested = ["url", "text", "selector", "requestId", "loadState", "networkQuietMs"].filter((key) => args[key] !== undefined);
  if (requested.length !== 1) throw new Error("wait_requires_one_condition");
  const key = requested[0];
  let operation;
  if (key === "url") operation = session.page.waitForURL(String(args.url), { timeout }).then(() => ({ condition: "url", actual: session.page.url() }));
  else if (key === "text") operation = session.page.getByText(String(args.text), { exact: true }).waitFor({ state: "visible", timeout }).then(() => ({ condition: "text", actual: String(args.text) }));
  else if (key === "selector") operation = session.page.locator(String(args.selector)).waitFor({ state: args.state || "visible", timeout }).then(() => ({ condition: "selector", state: args.state || "visible" }));
  else if (key === "loadState") operation = session.page.waitForLoadState(String(args.loadState), { timeout }).then(() => ({ condition: "loadState", state: String(args.loadState) }));
  else if (key === "requestId") operation = waitForRequestId(session, String(args.requestId), timeout, signal);
  else operation = waitForNetworkQuiet(session, Math.min(Number(args.networkQuietMs), 10_000), timeout, signal);
  try {
    return await Promise.race([operation, abortPromise(signal)]);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (/Timeout/i.test(error?.name || "") || /timeout/i.test(error?.message || "")) throw new SemanticError("wait_timeout", true);
    throw error;
  }
}

function waitForRequestId(session, requestId, timeout, signal) {
  if (session.requestIds?.has(requestId)) return Promise.resolve({ condition: "requestId", requestId });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SemanticError("wait_timeout", true)), timeout);
    const check = (id) => { if (id === requestId) { clearTimeout(timer); session.requestWaiters.delete(check); resolve({ condition: "requestId", requestId }); } };
    session.requestWaiters.add(check);
    signal.addEventListener("abort", () => { clearTimeout(timer); session.requestWaiters.delete(check); reject(new DOMException("cancelled", "AbortError")); }, { once: true });
  });
}

function waitForNetworkQuiet(session, quietMs, timeout, signal) {
  if (!Number.isFinite(quietMs) || quietMs < 1) throw new Error("wait_invalid_network_quiet");
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let quietSince = session.inflight === 0 ? Date.now() : null;
    const interval = setInterval(() => {
      if (session.inflight === 0) quietSince ??= Date.now(); else quietSince = null;
      if (quietSince && Date.now() - quietSince >= quietMs) finish(resolve, { condition: "networkQuiet", quietMs, readiness: "observation_only" });
      else if (Date.now() - started >= timeout) finish(reject, new SemanticError("wait_timeout", true));
    }, Math.min(50, quietMs));
    const finish = (fn, value) => { clearInterval(interval); fn(value); };
    signal.addEventListener("abort", () => finish(reject, new DOMException("cancelled", "AbortError")), { once: true });
  });
}

export async function captureScreenshot(session, args) {
  if (!session.artifacts) throw new Error("artifact_store_unavailable");
  if (args.name != null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(String(args.name))) throw new Error("screenshot_name_invalid");
  const locatorArgs = { ref: args.ref, selector: args.selector };
  const hasTarget = Boolean(args.ref || args.selector);
  const image = hasTarget
    ? await (await resolveSemanticTarget(session, locatorArgs)).screenshot()
    : await session.page.screenshot({ fullPage: Boolean(args.fullPage) });
  const artifact = session.artifacts.write("screenshots", image, { contentType: "image/png" });
  return { source: "untrusted_browser_observation", name: args.name || "screenshot", ...artifact };
}
