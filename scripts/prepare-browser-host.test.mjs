import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Integration check: first run may download Chromium.
test("preparation is repeatable and bundled Chromium launches", async () => {
  const script = fileURLToPath(
    new URL("./prepare-browser-host.mjs", import.meta.url),
  );
  for (let i = 0; i < 2; i++)
    execFileSync(process.execPath, [script], { stdio: "inherit" });
  for (const name of ["playwright", "playwright-core"]) {
    assert.ok(
      existsSync(
        new URL(
          `../src-tauri/browser-host/node_modules/${name}/package.json`,
          import.meta.url,
        ),
      ),
    );
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH = fileURLToPath(
    new URL("../src-tauri/browser-host/.browsers", import.meta.url),
  );
  const { chromium } = await import(
    "../src-tauri/browser-host/node_modules/playwright/index.mjs"
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<title>Browser ready</title>");
    assert.equal(await page.title(), "Browser ready");
  } finally {
    await browser.close();
  }
});
