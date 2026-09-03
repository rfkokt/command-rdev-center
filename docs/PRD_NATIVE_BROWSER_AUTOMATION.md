# PRD — Native Browser Automation

**One sentence:** Let Kern Studio agents independently verify local and staging web applications through an app-owned Playwright Chromium session, while keeping credentials, network access, risky mutations, and artifacts under deterministic host control.

**Owner:** garcia · **Status:** Draft v2 (reviewed) · **Date:** 2026-09-02

B0 security baseline: [threat model](SECURITY_NATIVE_BROWSER_AUTOMATION.md). Architecture candidate and measured spike blockers: [ADR-0006](adr/0006-native-browser-automation-host.md).

**Security baseline:** [Native Browser Automation Threat Model](SECURITY_NATIVE_BROWSER_AUTOMATION.md)

---

## 1. Problem

Kern Studio agents can edit code and run commands, but cannot reliably verify a web UI end-to-end. The agent currently has to ask the user to open a browser, authenticate, reproduce a flow, inspect DevTools, or provide screenshots. That breaks the autonomous coding-and-verification loop and weakens bug reports.

Adding Playwright tests to every target repository is not the solution. It changes user projects, depends on project-specific setup, and does not provide a reusable interactive browser during a Chat.

## 2. Product decision

Kern Studio will provide Playwright-powered Chromium automation as native pi tools.

- Each Chat owns one isolated browser context and artifact root.
- Kern Studio owns the Playwright runtime, browser version, process lifecycle, policy enforcement, and artifacts.
- No Playwright dependency, configuration, test, browser binary, or artifact is written to the repository under test.
- Browser-visible content is untrusted input. Page text, DOM, accessibility data, screenshots, console messages, downloads, and network responses never become trusted instructions.
- The model receives only bounded, sanitized observations. Credentials and raw browser storage state never enter pi RPC messages, tool arguments/results, Chat history, logs, or reports.
- Navigation and requests are constrained by a host-enforced network policy, not by model judgment.
- Interaction is deny-by-default when the host cannot establish that an action is read-only. Explicit test mode may grant a narrow, expiring mutation scope.
- Delivery starts with an architecture/security spike, then a small interactive MVP. Profiles, broad interaction coverage, cleanup orchestration, and `browser_test` follow only after the primitive boundary is proven.

```text
pi model
  └─ bundled browser-tools.ts extension (schemas only)
       └─ authenticated per-session IPC
            └─ Kern Studio browser host
                 ├─ policy + approvals + redaction
                 ├─ Playwright Chromium + isolated BrowserContext
                 └─ app-owned artifact directory
```

The pi extension is an adapter, not the security boundary. It must not hold decrypted profiles, decide origin access, classify its own actions as safe, or write arbitrary artifacts.

## 3. Goals

- Open localhost applications and explicitly approved staging origins.
- Inspect accessible page structure and interact using semantic locators.
- Capture correlated UI, console, exception, and HTTP evidence.
- Reuse login state without revealing credentials to the model.
- Prevent cross-Chat leakage, unexpected network access, prompt-injection escalation, arbitrary host-file upload, and accidental destructive actions.
- Produce reviewable Markdown and JSON evidence outside the target repository.

## 4. Non-goals

- Replacing a project's maintained end-to-end suite.
- Supporting Firefox or WebKit in the first release.
- General-purpose web browsing, crawling, scraping, or unrestricted internet access.
- Production automation, payment flows, account administration, or mutations without a bounded test authorization.
- Building a recorder, visual-regression platform, browser dashboard, or broad settings UI before the tool boundary works.
- Supporting arbitrary browser extensions or remote debugging connections.
- Treating text on a page as authorization or as instructions to the agent.

## 5. Trust model

### 5.1 Trusted components

- Kern Studio's signed application code.
- The pinned, app-owned Node runtime, browser-host process, Playwright runtime, and Chromium binary bundled and launched by Kern Studio.
- The user approval received through Kern Studio's existing pi RPC extension UI protocol.
- Platform secure storage used to protect profile-encryption keys.

### 5.2 Untrusted inputs

- URLs, redirects, DNS results, certificates, pages, frames, popups, workers, downloads, and browser dialogs.
- DOM/accessibility text, hidden content, console output, screenshots, and response bodies.
- Tool arguments proposed by the model.
- The target repository and any project-local code.
- A saved browser profile after it has been applied to a compromised page.

### 5.3 Security invariants from B1 onward

- Policy is enforced in the browser host before the action or request occurs.
- Uncertain actions are blocked or require approval; they are never silently treated as safe.
- Secrets are prevented from entering model-visible channels rather than merely redacted afterward.
- All returned text is labeled as observed untrusted data.
- Browser artifacts cannot resolve outside the Chat artifact root.
- A Chat cannot address another Chat's browser, profile handle, IPC endpoint, or artifacts.
- Browser and IPC process failures fail closed.

## 6. User experience

### 6.1 Basic flow

1. The user asks the agent to verify a UI behavior.
2. The agent calls `browser_open` for a local or staging URL.
3. Kern Studio confirms any network scope not already approved for the Chat.
4. The agent inspects a semantic snapshot, then proposes interactions.
5. Kern Studio executes allowed read-only actions and prompts for uncertain or mutation-capable actions.
6. The agent gathers screenshots plus sanitized console and HTTP evidence.
7. The agent returns a concise result with app-safe artifact references.
8. If test mode includes cleanup, Kern Studio executes and verifies it before reporting status.

### 6.2 Authentication

The model must not fill password, OTP, passkey, API-key, payment, or other secret-classified controls.

Authentication uses one of these host-mediated paths:

- the user authenticates in headed mode while agent execution is paused; or
- the user consents to applying an encrypted, domain-scoped profile.

`browser_fill` rejects secret-classified controls and secret-shaped values. Profile application returns only profile name, allowed origins, and success/failure. Raw cookies, local storage, IndexedDB, session storage, and headers are never returned.

### 6.3 Approvals and test mode

Normal mode requires approval for every action that is mutation-capable or uncertain, including form submission, destructive controls, file upload, download execution/opening, cross-origin navigation, and interactions whose effect cannot be determined before execution.

An approval request shows:

- origin and current URL;
- action type;
- element role/name and a bounded surrounding-text preview;
- masked proposed value where relevant;
- expected network/mutation scope;
- one-shot or time-bounded scope and expiry.

Explicit test mode may pre-authorize only a declared combination of origins, HTTP methods/routes, named test records, action classes, duration, and cleanup steps. It never disables network restrictions, credential isolation, or output sanitization.

## 7. Network policy

### 7.1 Destination classes

Only `http:` and `https:` are supported. Top-level `file:`, `data:`, `javascript:`, browser-internal schemes, URLs containing credentials, and arbitrary custom schemes are denied. `blob:` resources may only derive from an already approved document and are not independent navigation targets.

Network destinations are classified before connection:

- **Local development:** loopback only, explicitly approved for the Chat.
- **Remote staging:** public HTTPS origin explicitly approved for the Chat.
- **Denied by default:** private LAN, link-local, multicast, unspecified, mapped-private addresses, cloud metadata endpoints, and any destination that changes to a more privileged network class.

The implementation must centralize or reuse the project's tested IP classification rather than create weaker browser-specific checks.

### 7.2 Enforcement

Normal browser traffic is forced through an authenticated, host-owned loopback proxy configured at Chromium launch. Under the approved boundary, pinned app-owned Chromium and its runtime are trusted to honor that proxy configuration; OS-level containment of direct sockets after Chromium compromise is an accepted residual risk and is out of scope. This decision does not permit proxy bypass in supported browser behavior.

- Resolve and validate every hostname; revalidate redirects and changed DNS answers to mitigate rebinding.
- Recheck top-level navigation, popup, iframe navigation, fetch/XHR, form navigation, WebSocket, beacon, worker, and service-worker requests.
- Passive cross-origin subresources needed to render an approved page may be allowed only when they remain in the same network class, use safe retrieval methods, carry no injected credentials, and are logged.
- Cross-origin mutation-capable requests, credentialed requests, or transitions to another network class require explicit approval or are denied.
- A new top-level origin always requires approval.
- Clear inherited proxy settings, disable QUIC, and ensure all supported HTTP(S), WebSocket, worker, and service-worker traffic uses the authenticated host proxy; any supported request that cannot be validated is blocked.

HTTP method alone is not proof that an operation is read-only. The host may use it as one signal, but uncertain requests remain gated.

## 8. Functional requirements by phase

### 8.1 Invariants — B1+

- **Must/B1** isolate BrowserContext, IPC capability, artifacts, and event buffers by Chat.
- **Must/B1** enforce the network and action policies before execution.
- **Must/B1** bound snapshot, console, network, response-body, and screenshot metadata output.
- **Must/B1** sanitize all model-visible data and prevent secret inputs from entering model-visible channels.
- **Must/B1** close browser resources on `browser_close`, pi `session_shutdown`, Chat replacement, app quit, crash recovery, and timeout.
- **Must/B1** keep every artifact outside the target repository.
- **Must/B1** honor cancellation through the tool's abort signal and leave the context in a known state.

### 8.2 Primitive MVP — B1

- **Must/B1** open one approved page in app-managed Chromium.
- **Must/B1** return a bounded ARIA snapshot or equivalent semantic snapshot with roles, accessible names, visible text, relevant form state, and host-issued element references.
- **Must/B1** locate by role/name, label, placeholder, or text before explicit selector fallback.
- **Must/B1** click and fill non-secret controls under the action policy.
- **Must/B1** wait for URL, text, selector state, load state, and bounded network quiescence.
- **Must/B1** capture page or element screenshots.
- **Must/B1** collect console errors, uncaught page exceptions, HTTP responses, and transport failures.
- **Must/B1** distinguish HTTP error responses from transport failures and browser/AbortController cancellation.
- **Must/B1** correlate a UI action with observed requests and responses using stable event IDs and timing.

`networkIdle` is an optional observation, not the universal definition of readiness. Long polling, analytics, WebSockets, service workers, and background requests can prevent or falsify idleness; explicit UI/network conditions are preferred.

### 8.3 Complete primitives and profiles — B2

- **Must/B2** support select, keyboard input, scroll, explicit submit, and user-approved file upload.
- **Must/B2** support assertions for URL, visibility, text, form value, table row, toast, dialog, and HTTP status.
- **Must/B2** support encrypted profile save, apply, inspect metadata, overwrite, revoke, and delete.
- **Must/B2** support explicit test mode and declared cleanup steps.
- **Must/B2** verify cleanup through an observable assertion or response.
- **Must/B2** define download handling: quarantine in the artifact root, never auto-open or execute, and expose only sanitized metadata unless the user explicitly exports it.

File upload accepts only a host-issued handle for a file the user selected or explicitly attached to the Chat. Model-supplied filesystem paths are rejected. The host validates canonical path, symlinks, size, file type, and expiry before upload.

### 8.4 Scenario runner and reports — B3

- **Must/B3** compose existing primitives through `browser_test` rather than introduce a second engine.
- **Must/B3** generate deterministic step, assertion, network, artifact, and cleanup results.
- **Must/B3** generate Markdown and versioned JSON reports.
- **Must/B3** capture screenshot, semantic snapshot, console, exception, and network evidence automatically on failure.
- **Must/B3** use retention limits and allow the user to delete a Chat's browser artifacts.

## 9. Native tool contract

All tools return a common envelope:

```ts
type BrowserToolResult<T> = {
  status:
    | "ok"
    | "approval_required"
    | "blocked"
    | "timeout"
    | "cancelled"
    | "error";
  data?: T;
  error?: { code: string; message: string; retryable: boolean };
  artifactRefs?: string[];
};
```

Artifact references are opaque app IDs, not arbitrary filesystem paths. Tool calls fail with a stable error when no page is open, the session is closing, an element reference is stale, a locator is ambiguous, policy denies the action, or the browser host is unavailable.

### 9.1 B1 tools

```ts
browser_open({ url, headed? })
browser_snapshot({ rootRef?, maxChars? })
browser_click({ ref?, role?, name?, selector? })
browser_fill({ ref?, role?, name?, label?, selector?, value })
browser_wait({ url?, text?, selector?, requestId?, networkQuietMs?, timeout? })
browser_network({ since?, method?, urlPattern?, status?, includeBody? })
browser_console({ since?, level? })
browser_screenshot({ name?, fullPage?, ref?, selector? })
browser_close()
```

- `browser_open` creates or reuses only the current Chat context and returns sanitized page metadata.
- `browser_snapshot` uses Playwright's ARIA snapshot capability where available, then applies output bounds and host-issued references.
- `browser_click` and `browser_fill` reject ambiguous matches. Explicit selectors remain an escape hatch and do not bypass policy.
- `browser_fill` rejects secret controls and secret-shaped values.
- `browser_wait` reports the condition that completed; timeout defaults and maxima are host-owned.
- `browser_network` is cursor-based. Response bodies are opt-in, bounded, text-safe, content-type checked, and sanitized. Binary bodies are artifact-only.
- `browser_console` returns console errors and uncaught page exceptions with bounds and cursors.
- `browser_screenshot` accepts a logical name, never a raw output path.
- `browser_close` is idempotent.

### 9.2 B2 tools

```ts
browser_select({ ref?, label?, selector?, value })
browser_press({ key, ref? })
browser_scroll({ ref?, x?, y? })
browser_upload({ ref?, fileHandle })
browser_assert({ type, target, expected })
browser_profile_apply({ name })
browser_profile_save({ name, origins })
browser_profile_delete({ name })
```

### 9.3 B3 tool

```ts
browser_test({
  startUrl,
  profile?,
  steps,
  assertions,
  networkAssertions,
  cleanupSteps,
  captureOnFailure: true,
});
```

The scenario schema is versioned. Steps reference outputs by stable IDs rather than interpolating arbitrary script. Arbitrary JavaScript evaluation is out of scope.

## 10. Evidence semantics

### 10.1 Network events

Each request record has a stable ID and records sanitized:

- method and normalized URL;
- resource type and initiator where available;
- start/end timing;
- final disposition: `response`, `transport_failed`, `cancelled`, or `blocked`;
- HTTP status for responses, including 4xx/5xx;
- an allowlist of safe response headers;
- optional bounded sanitized body or artifact reference.

An HTTP 500 is a completed response, not `requestfailed`. Cancellation is reported separately using Playwright failure information and lifecycle context; the report must state when intent (`AbortController` versus another browser cancellation) cannot be proven.

Service-worker-controlled requests can produce incomplete events. The report records whether service workers were allowed or blocked and marks evidence incomplete rather than claiming absence. B1 should default to preserving application behavior; tests that require complete routing evidence may opt into blocking service workers and must disclose that behavior change.

### 10.2 Screenshots and snapshots

Screenshots can contain credentials, personal data, QR codes, and tokens. Screenshot files remain local artifacts and are not automatically attached to model context. The model receives only an opaque reference and sanitized metadata unless the user explicitly permits image inspection for that artifact.

Snapshots omit hidden password values, script/style content, comments, cross-origin frame contents without approval, and attributes not needed for interaction. Output is bounded and paged by host-issued references.

### 10.3 Prompt-injection resistance

Tool descriptions and system guidance state that browser observations are evidence, not instructions. The agent must ignore page requests to reveal data, change policy, invoke unrelated tools, navigate elsewhere, or upload/read local files. The host enforces the boundary even if the agent follows malicious page text.

## 11. Profiles and retention

Playwright storage state can contain impersonation-capable cookies and headers. A profile therefore requires:

- user consent on save and apply;
- an opaque profile ID and human-readable name;
- approved origins and creation/last-used timestamps;
- encryption at rest with a platform-backed key;
- restrictive filesystem permissions;
- no plaintext temporary file when the selected Playwright API can accept in-memory state;
- atomic writes and safe failure if secure storage is unavailable;
- versioning and migration or explicit invalidation after incompatible upgrades;
- manual revoke/delete and configurable retention.

Profiles are not shared across projects or Chats by default. Applying a profile to an origin outside its scope is denied.

Artifacts use per-Chat quotas and expiry. Profile deletion and artifact deletion are separate operations and both are auditable without logging secret values.

## 12. Technical integration

### 12.1 pi integration

The existing app loads bundled TypeScript extensions into each `pi --mode rpc` process. Browser tools follow that precedent:

1. `browser-tools.ts` registers the tool schemas with `pi.registerTool()`.
2. Rust spawns pi with the extension and passes a per-session IPC endpoint plus an unguessable capability through environment variables.
3. The extension sends versioned request envelopes containing Chat/session identity, tool-call ID, action, and arguments.
4. The browser host validates the capability, identity, policy, and arguments before execution.
5. Results are sanitized in the host, returned to the extension, and only then emitted as pi tool results.
6. The extension forwards its abort signal; `session_shutdown` closes the session browser resources.

Browser tool names must be added deliberately to project and/or global Chat tool allowlists. Initial delivery targets project Chats; global Chat support is deferred until its broader origin and repository context is defined.

Approval uses `ctx.ui.confirm/select` in the bundled pi extension, which already maps to `extension_ui_request`/`extension_ui_response` in RPC mode. The browser host supplies the structured approval preview and refuses execution until the matching approval scope is returned.

### 12.2 Browser runtime decision gate — B0

Implementation must not start B1 until an ADR and packaged spike choose and prove the browser-host process model. The preferred candidate is an app-bundled Playwright/Node sidecar because it provides the required Playwright APIs; this is an explicit exception to the earlier preference to avoid Node sidecars.

The ADR must define:

- exact Playwright and Chromium versions;
- sidecar/runtime packaging for each supported target and Tauri target-triple naming;
- browser binary location using an app-owned browser path;
- package size, install/update, signing, and offline behavior;
- IPC framing, authentication, cancellation, event streaming, health, restart, and shutdown;
- crash recovery and orphan-process prevention;
- compatibility with the Windows/WSL product direction;
- proof that a packaged build can launch headed/headless Chromium, isolate two contexts, capture an ARIA snapshot and screenshot, observe network/console events, and shut down cleanly.

A maintained non-Node Playwright-compatible host may replace the preferred candidate only if the spike proves equivalent API coverage and lowers lifecycle cost.

### 12.3 Artifact layout

```text
<app-data>/sessions/<chat-id>/browser/
  screenshots/
  snapshots/
  bodies/
  downloads/
  network.jsonl
  console.jsonl
  report.md
  report.json
```

The directory is created with restrictive permissions. Every path is canonicalized beneath this root. The app resolves opaque artifact references for preview/export; browser tools never receive arbitrary output paths.

## 13. Delivery and acceptance

### Phase B0 — architecture and threat-model spike

Deliver:

- ADR selecting the process/IPC/package architecture and referencing the [browser automation threat model](SECURITY_NATIVE_BROWSER_AUTOMATION.md);
- threat model covering credential entry, prompt injection, SSRF/rebinding, origin transitions, profiles, uploads/downloads, screenshots, and action approval;
- packaged smoke spike on the currently supported macOS target;
- measured app-size and browser-install impact.

**B0 exit:** the packaged spike proves the lifecycle described in §12.2 and no blocker remains in the model→extension→host call chain under the approved proxy boundary. OS-level containment after compromise of the pinned Chromium/runtime is not a B0 requirement.

### Phase B1 — safe interactive primitives

Deliver the B1 tools in §9.1, host policy, bounded evidence, and Chat teardown.

**B1 acceptance:**

- Open an approved localhost page and one approved staging origin.
- Prove two Chats cannot access each other's context, IPC capability, or artifacts.
- Snapshot, click a non-secret control, fill a non-secret field, and activate an explicitly located submit control after approval.
- Capture before/after screenshots and retrieve console plus correlated HTTP evidence.
- Detect an HTTP 500 with sanitized body and distinguish it from transport failure and cancellation.
- Block a new top-level origin, denied network class, secret-field fill, arbitrary artifact path, and uncertain mutation without approval.
- Close on tool call and Chat teardown without orphan processes.
- Leave the target repository byte-for-byte free of browser dependencies and artifacts.

### Phase B2 — profiles, complete interactions, assertions, and cleanup

**B2 acceptance:**

- User authenticates through headed takeover or applies an encrypted scoped profile without credential exposure to pi RPC/history/logs.
- Select, keyboard, scroll, upload via a host-issued handle, and explicit submit work.
- Assertions return actual, expected, evidence reference, and failure reason.
- Explicit test mode permits only its declared mutation scope and expires correctly.
- Cleanup status is verified, failed, or skipped—never inferred.

### Phase B3 — scenario runner and reports

**B3 acceptance:**

- `browser_test` composes the existing primitives and cannot execute arbitrary JavaScript.
- A failed scenario captures bounded evidence automatically.
- Markdown and versioned JSON reports contain steps, assertions, HTTP evidence, artifacts, redaction summary, and cleanup status.
- Artifact retention and deletion work.

No dashboard or broad settings UI is included in B0–B3 unless proven necessary.

## 14. Verification scenarios

### 14.1 B1 non-destructive proof

1. Open a local fixture application.
2. Snapshot the page.
3. Fill a non-secret form field.
4. Approve and click its explicit submit control.
5. Wait for the resulting request and visible confirmation.
6. Record console/network evidence and screenshots.
7. Close and verify cleanup of the browser process/context.

### 14.2 Master Penugasan proof — B2/B3

1. Open the approved **Master Penugasan** page with a disposable, uniquely identified test record.
2. Capture a pre-action screenshot and snapshot.
3. Locate the record by exact test identifier; fuzzy matching alone is forbidden.
4. Receive a structured delete approval or use a matching test-mode scope.
5. Delete the record and wait for the correlated `DELETE` response.
6. Wait for the subsequent list `GET` response.
7. Assert that the exact test identifier no longer appears.
8. Capture the final screenshot and sanitized `DELETE`/`GET` evidence.
9. If the record remains, report a suspected backend defect with evidence; do not claim the backend is solely responsible if cache, service worker, race, or incomplete network visibility remains plausible.

## 15. Risks and mitigations

| Risk                                       | Mitigation                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Credential enters model context            | Reject secret fills; headed user takeover or host-only profile injection                                     |
| Prompt injection from page content         | Mark observations untrusted; deterministic host policy; no arbitrary JS or local-file access                 |
| SSRF, DNS rebinding, or LAN access         | Authenticated host proxy; resolve/revalidate destinations; deny privileged ranges; validate redirects/subrequests |
| B1 mutates data unexpectedly               | Conservative approval gate ships before click/fill; uncertain means approval-required                        |
| Cross-Chat leakage                         | Per-session capability, BrowserContext, buffers, and artifact root; isolation tests                          |
| Profile theft                              | Platform-backed encryption, scoped application, restrictive permissions, consent, revocation                 |
| Upload exfiltrates host files              | User-selected expiring handle only; canonicalization, symlink/size/type checks                               |
| Download executes malware                  | Quarantine under artifact root; never auto-open/execute                                                      |
| Screenshot exposes secrets                 | Local artifact by default; explicit consent before model image inspection                                    |
| Missing network evidence                   | Record service-worker policy and evidence completeness; never infer absence from missing events              |
| Oversized output or disk growth            | Cursor-based bounded output, body limits, quotas, retention, deletion                                        |
| Sidecar packaging/release failure          | B0 packaged spike, pinned versions, signing/update/offline plan                                              |
| Browser crash or app exit leaves processes | Supervision, cancellation, idempotent shutdown, orphan-process acceptance test                               |
| Compromised Chromium opens a direct socket | Accepted residual risk: pinned app-owned runtime is trusted; rapid updates and platform sandbox are defense in depth |

## 16. Open questions

1. What artifact and profile retention defaults balance debugging value with privacy and disk use?
2. Should headed user takeover remain paused until the user explicitly returns control, or can the agent resume on navigation completion? Proposed: explicit “Return control to agent.”
3. Which exact mutation scopes are safe enough for test mode after B2 usage data? Start with exact origin + method/route + exact test-record identifier + expiry.
4. Should service workers be preserved by default for fidelity or blocked for stronger network evidence? Proposed: preserve by default, disclose evidence gaps, allow an explicit evidence mode that blocks them.
5. When Windows support lands, should Chromium run on the Windows host or inside WSL? This must be resolved in the B0 ADR against the shared execution-context plan.

## 17. Research basis

- Playwright `locator.ariaSnapshot()` provides YAML ARIA snapshots containing roles, accessible names, and text; available since Playwright 1.49.
- Playwright warns that stored authentication state can contain impersonation-capable cookies and headers. Current storage state can include cookies, local storage, IndexedDB, and passkey-related state; session storage requires separate handling.
- Playwright distinguishes HTTP error responses from transport-level request failures. Service workers can hide events from routing/interception, so evidence completeness must be explicit.
- Playwright supports app-owned browser locations through `PLAYWRIGHT_BROWSERS_PATH`; Chromium consumes hundreds of megabytes and therefore affects installation/update design.
- Tauri supports bundled sidecars through `bundle.externalBin`; each target requires the correctly named target-triple executable and corresponding signing/release handling.
- pi extensions can register native model tools, clean up on `session_shutdown`, accept abort signals, and request approvals through RPC `extension_ui_request`/`extension_ui_response`.
