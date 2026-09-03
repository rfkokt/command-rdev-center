# Browser host B0 spike

Architecture/security proof only; it is not wired to pi or production commands.

```sh
npm ci --ignore-scripts
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
npm test
npm run smoke
```

The package pins Node/Playwright in `package.json` and npm dependencies in `package-lock.json`. Release proof must run with the exact Node runtime and app-owned Chromium. `KERN_BROWSER_EXECUTABLE` exists only to run bounded local API checks when the browser download is unavailable; results using it are not packaged acceptance evidence.

The JSONL host requires a 64-hex-character (256-bit) `KERN_BROWSER_CAPABILITY` and an exact `KERN_BROWSER_SESSION_ID`. Frames are bounded to 1 MiB. Supported spike actions are `health`, `isolate`, `smoke`, `sleep`, `cancel`, and `shutdown`. This deliberately omits navigation policy, approvals, profiles, artifact persistence, and pi registration until ADR-0006's packaged gate passes.

The macOS arm64 bundle includes the exact Node 22.18.0 executable, locked Playwright modules, and the app-owned Chromium revision as Tauri resources. Rust owns capability generation, environment allowlisting, JSONL request IDs, process-group supervision, revoke-first shutdown, and the dev/test-only `browser_b0_packaged_smoke` command. Release builds require `KERN_ENABLE_BROWSER_B0_SPIKE=1` to invoke that command; no pi/B1 tool is registered.
