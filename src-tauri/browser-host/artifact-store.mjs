import {
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";

const KINDS = new Set([
  "screenshots",
  "snapshots",
  "bodies",
  "downloads",
  "network",
  "console",
]);
const SAFE_HEADERS = new Set([
  "content-type",
  "content-length",
  "cache-control",
  "etag",
  "last-modified",
  "location",
  "retry-after",
]);
const SECRET_KEY =
  /authorization|cookie|password|passwd|token|secret|api[-_]?key|session|credential|otp/i;
const SECRET_VALUE =
  /(?:bearer\s+[a-z0-9._~+\/-]{8,}|(?:api[-_]?key|token|secret|password)\s*[:=]\s*[^\s,;}]{4,})/i;
const DEFAULT_QUOTA = 50 * 1024 * 1024;
const MAX_TEXT_BODY = 256 * 1024;
const MAX_OBSERVATION = 64 * 1024;

function contained(root, path) {
  const base = resolve(root);
  const candidate = resolve(path);
  return candidate === base || candidate.startsWith(`${base}${sep}`);
}

function safeText(value, max = MAX_OBSERVATION) {
  const text = String(value ?? "");
  if (SECRET_VALUE.test(text)) return "[REDACTED]";
  return text.slice(0, max);
}

export function sanitizeUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("sanitization_failed");
  }
  if (url.username || url.password) throw new Error("sanitization_failed");
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_KEY.test(key)) url.searchParams.set(key, "[REDACTED]");
  }
  return url.toString().slice(0, 2_000);
}

export function sanitizeObservation(value, depth = 0) {
  if (depth > 12) throw new Error("sanitization_failed");
  if (value == null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (typeof value === "string") return safeText(value);
  if (Array.isArray(value))
    return value
      .slice(0, 200)
      .map((item) => sanitizeObservation(item, depth + 1));
  if (typeof value !== "object") throw new Error("sanitization_failed");
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 200)) {
    if (SECRET_KEY.test(key)) output[key] = "[REDACTED]";
    else if (/url/i.test(key) && typeof item === "string")
      output[key] = sanitizeUrl(item);
    else if (
      /headers?/i.test(key) &&
      item &&
      typeof item === "object" &&
      !Array.isArray(item)
    ) {
      output[key] = Object.fromEntries(
        Object.entries(item)
          .filter(([name]) => SAFE_HEADERS.has(name.toLowerCase()))
          .map(([name, header]) => [
            name.toLowerCase(),
            safeText(header, 2_000),
          ]),
      );
    } else output[key] = sanitizeObservation(item, depth + 1);
  }
  return output;
}

export function boundedPage(items, cursor = 0, limit = 100) {
  const start = Math.max(0, Number.isSafeInteger(cursor) ? cursor : 0);
  const count = Math.min(
    100,
    Math.max(1, Number.isSafeInteger(limit) ? limit : 100),
  );
  const data = items
    .slice(start, start + count)
    .map((item) => sanitizeObservation(item));
  return {
    source: "untrusted_browser_observation",
    data,
    nextCursor: start + data.length < items.length ? start + data.length : null,
    truncated: start + data.length < items.length,
  };
}

export class ArtifactStore {
  constructor(root, sessionId, { quota = DEFAULT_QUOTA } = {}) {
    if (
      !/^[A-Za-z0-9_-]{1,200}$/.test(sessionId) ||
      !resolve(root).endsWith(`${sep}sessions${sep}${sessionId}${sep}browser`)
    )
      throw new Error("artifact_root_invalid");
    this.root = resolve(root);
    this.sessionId = sessionId;
    this.quota = quota;
    this.refs = new Map();
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink())
      throw new Error("artifact_symlink_blocked");
    this.realRoot = realpathSync(this.root);
    for (const kind of KINDS)
      mkdirSync(join(this.root, kind), { recursive: true, mode: 0o700 });
  }

  used() {
    let total = 0;
    for (const path of this.refs.values()) {
      try {
        total += statSync(path).size;
      } catch {}
    }
    return total;
  }

  write(
    kind,
    data,
    { contentType = "application/octet-stream", text = false } = {},
  ) {
    if (!KINDS.has(kind) || (typeof data === "string" && !text))
      throw new Error("artifact_invalid");
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    if (text && bytes.length > MAX_TEXT_BODY)
      throw new Error("artifact_body_too_large");
    if (this.used() + bytes.length > this.quota)
      throw new Error("artifact_quota_exceeded");
    const id = randomBytes(16).toString("hex");
    const dir = join(this.root, kind);
    if (
      !contained(this.realRoot, realpathSync(dir)) ||
      lstatSync(dir).isSymbolicLink()
    )
      throw new Error("artifact_symlink_blocked");
    const path = join(dir, id);
    const temp = `${path}.tmp`;
    if (!contained(this.root, temp)) throw new Error("artifact_path_blocked");
    const fd = openSync(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    this.refs.set(id, path);
    return {
      artifactRef: `browser-artifact:${this.sessionId}:${id}`,
      contentType,
      bytes: bytes.length,
      modelAttachment: false,
    };
  }

  resolve(ref, requestingSessionId) {
    const match = /^browser-artifact:([A-Za-z0-9_-]+):([0-9a-f]{32})$/.exec(
      String(ref),
    );
    if (
      !match ||
      match[1] !== this.sessionId ||
      requestingSessionId !== this.sessionId
    )
      throw new Error("artifact_access_denied");
    const path = this.refs.get(match[2]);
    if (
      !path ||
      lstatSync(path).isSymbolicLink() ||
      !contained(this.realRoot, realpathSync(path))
    )
      throw new Error("artifact_access_denied");
    return path;
  }
}

export function sanitizeBody(body, contentType, store) {
  const type = String(contentType ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const textual =
    type.startsWith("text/") ||
    type === "application/json" ||
    type.endsWith("+json");
  if (!textual)
    return {
      source: "untrusted_browser_observation",
      ...store.write("bodies", Buffer.from(body), {
        contentType: type || "application/octet-stream",
      }),
    };
  const bytes = Buffer.from(body);
  if (bytes.length > MAX_TEXT_BODY)
    return {
      source: "untrusted_browser_observation",
      ...store.write("bodies", bytes, { contentType: type, text: true }),
    };
  let value = bytes.toString("utf8");
  if (type === "application/json" || type.endsWith("+json")) {
    try {
      value = JSON.stringify(sanitizeObservation(JSON.parse(value)));
    } catch (error) {
      if (error.message === "sanitization_failed") throw error;
      value = safeText(value);
    }
  } else value = safeText(value);
  return {
    source: "untrusted_browser_observation",
    contentType: type,
    body: value,
    truncated: false,
  };
}
