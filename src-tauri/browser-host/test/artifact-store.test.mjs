import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ArtifactStore,
  boundedPage,
  sanitizeBody,
  sanitizeObservation,
  sanitizeUrl,
} from "../artifact-store.mjs";

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "kern-artifacts-"));
  const root = join(base, "sessions", "chat-a", "browser");
  return {
    base,
    root,
    store: new ArtifactStore(root, "chat-a", { quota: 1024 }),
  };
}

test("restricts roots, opaque refs, permissions and cross-chat access", async (t) => {
  const { base, root, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  const saved = store.write("screenshots", Buffer.from("png"), {
    contentType: "image/png",
  });
  assert.match(saved.artifactRef, /^browser-artifact:chat-a:[0-9a-f]{32}$/);
  assert.equal(saved.modelAttachment, false);
  const path = store.resolve(saved.artifactRef, "chat-a");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, "utf8"), "png");
  assert.throws(
    () => store.resolve(saved.artifactRef, "chat-b"),
    /artifact_access_denied/,
  );
  assert.throws(
    () => store.resolve("/tmp/file", "chat-a"),
    /artifact_access_denied/,
  );
  assert.throws(
    () => store.resolve("browser-artifact:chat-a:..", "chat-a"),
    /artifact_access_denied/,
  );
  assert.throws(
    () => new ArtifactStore(join(base, "repo", "browser"), "chat-a"),
    /artifact_root_invalid/,
  );
});

test("rejects symlink storage and quota overflow", async (t) => {
  const { base, root, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const outside = join(base, "outside");
  mkdirSync(outside);
  rmSync(join(root, "downloads"), { recursive: true, force: true });
  symlinkSync(outside, join(root, "downloads"));
  assert.throws(
    () => store.write("downloads", Buffer.from("x")),
    /artifact_symlink_blocked/,
  );
  assert.throws(
    () => store.write("screenshots", Buffer.alloc(1025)),
    /artifact_quota_exceeded/,
  );
});

test("sanitizes recursive values, headers, URLs and bounded cursors", () => {
  const result = sanitizeObservation({
    password: "hunter2",
    nested: { authorization: "Bearer abcdefghijkl", ok: "safe" },
    url: "https://example.test/a?token=secret&view=list",
    headers: {
      Authorization: "Bearer nope",
      Cookie: "x=y",
      "Content-Type": "application/json",
      ETag: "abc",
    },
  });
  assert.equal(result.password, "[REDACTED]");
  assert.equal(result.nested.authorization, "[REDACTED]");
  assert.equal(result.nested.ok, "safe");
  assert.match(result.url, /token=%5BREDACTED%5D/);
  assert.deepEqual(result.headers, {
    "content-type": "application/json",
    etag: "abc",
  });
  assert.throws(
    () => sanitizeUrl("https://user:pass@example.test"),
    /sanitization_failed/,
  );
  assert.throws(
    () =>
      sanitizeObservation({
        a: {
          b: {
            c: {
              d: {
                e: {
                  f: { g: { h: { i: { j: { k: { l: { m: { n: 1 } } } } } } } },
                },
              },
            },
          },
        },
      }),
    /sanitization_failed/,
  );
  const page = boundedPage(
    Array.from({ length: 150 }, (_, id) => ({ id })),
    90,
    1000,
  );
  assert.equal(page.source, "untrusted_browser_observation");
  assert.equal(page.data.length, 60);
  assert.equal(page.nextCursor, null);
});

test("keeps binary bodies artifact-only and bounds text bodies", async (t) => {
  const { base, store } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const binary = sanitizeBody(Buffer.from([0, 1, 2]), "image/png", store);
  assert.equal(binary.modelAttachment, false);
  assert.ok(binary.artifactRef);
  assert.equal(binary.body, undefined);
  const text = sanitizeBody(
    Buffer.from('{"token":"top-secret","message":"ok"}'),
    "application/json",
    store,
  );
  assert.equal(text.source, "untrusted_browser_observation");
  assert.match(text.body, /REDACTED/);
  assert.doesNotMatch(text.body, /top-secret/);
  assert.throws(
    () => sanitizeBody(Buffer.alloc(300_000), "text/plain", store),
    /artifact_body_too_large|artifact_quota_exceeded/,
  );
});
