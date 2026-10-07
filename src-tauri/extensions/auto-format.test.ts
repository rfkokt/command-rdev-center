// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFormatBatch, formatTarget } from "./auto-format";

const folders: string[] = [];
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "kern-format-"));
  folders.push(cwd);
  const formatter = join(cwd, "formatter.cjs");
  writeFileSync(
    formatter,
    `const fs = require('node:fs');
fs.appendFileSync(__dirname + '/calls', 'format\n');
const path = process.argv[3];
fs.writeFileSync(path, fs.readFileSync(path, 'utf8').replace(/unformatted/g, 'formatted'));`.replace(
      "'format\n'",
      "'format\\n'",
    ),
  );
  return { cwd, formatter };
}
afterEach(() =>
  folders
    .splice(0)
    .forEach((folder) => rmSync(folder, { recursive: true, force: true })),
);

describe("batched formatting", () => {
  it("formats repeated edits only once and drains concurrent callers without duplicate work", async () => {
    const { cwd, formatter } = fixture();
    const file = join(cwd, "source.ts");
    writeFileSync(file, "unformatted");
    const batch = createFormatBatch(cwd, formatter);
    batch.touch(file);
    batch.touch("source.ts");
    batch.touch(file);
    expect(readFileSync(file, "utf8")).toBe("unformatted");
    const results = await Promise.all([batch.flush(), batch.flush()]);
    expect(results.flatMap((result) => result.changed)).toEqual(["source.ts"]);
    expect(readFileSync(join(cwd, "calls"), "utf8")).toBe("format\n");
    expect(await batch.flush()).toEqual({ changed: [], errors: [] });
  });
  it("excludes memory, build output, and files outside the checkout", () => {
    const { cwd } = fixture();
    for (const file of [
      "memory.md",
      "node_modules/foo.ts",
      "dist/app.js",
      "src/app.min.js",
      "../outside.ts",
      "source.rs",
    ]) {
      expect(formatTarget(cwd, file)).toBeUndefined();
    }
    expect(formatTarget(cwd, "src/app.tsx")).toBe(resolve(cwd, "src/app.tsx"));
  });
  it("reports formatter errors and preserves queued work when already aborted", async () => {
    const { cwd, formatter } = fixture();
    writeFileSync(join(cwd, "source.ts"), "unformatted");
    const batch = createFormatBatch(cwd, formatter);
    batch.touch("source.ts");
    const controller = new AbortController();
    controller.abort();
    expect(await batch.flush(controller.signal)).toEqual({
      changed: [],
      errors: [],
    });
    expect((await batch.flush()).changed).toEqual(["source.ts"]);
    const broken = createFormatBatch(cwd, join(cwd, "missing.cjs"));
    broken.touch("source.ts");
    expect((await broken.flush()).errors).toEqual(["source.ts"]);
    expect((await broken.flush()).errors).toEqual(["source.ts"]);
  });
});
