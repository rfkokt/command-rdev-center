# Native Browser Automation Threat Model

**Scope:** Native Browser Automation B0–B3 · **Status:** B0 security baseline · **Date:** 2026-09-02

This document defines the security boundary that production browser automation must preserve. It complements [the product requirements](PRD_NATIVE_BROWSER_AUTOMATION.md); the B0 architecture ADR must reference this document and resolve every blocker in §9 before B1 begins.

## 1. Security objectives

1. Browser content cannot expand the agent's authority.
2. Credentials and raw browser state remain host-only and never enter pi RPC, Chat history, logs, reports, tool arguments, or tool results.
3. A Chat cannot access another Chat's browser context, capability, events, profiles, or artifacts.
4. Browser traffic reaches only destinations approved by deterministic host policy.
5. Mutation-capable or uncertain actions do not execute without an exact, current authorization.
6. Browser artifacts remain under an app-owned per-Chat root and are exposed only by opaque references.
7. Host, IPC, sidecar, browser, secure-storage, and policy failures fail closed and leave no orphaned authority or process.

Availability is secondary to confidentiality and integrity: when state or policy is uncertain, the action is blocked rather than retried permissively.

## 2. System and data flow

```text
User approval UI
       │ exact scoped decision
       ▼
pi model → bundled schema-only extension → authenticated per-Chat IPC
                                             │
                                             ▼
                                  Kern Studio browser host
                                  ├─ validation and policy
                                  ├─ approval binding
                                  ├─ redaction and bounds
                                  ├─ profile key access
                                  ├─ artifact store
                                  └─ Playwright → Chromium → untrusted network/page
```

The existing Chat is one ephemeral worktree plus one pi RPC process ([ADR-0001](adr/0001-chat-worktree-ephemeral-session-pi-default.md)). Browser authority must be bound to that concrete Chat identity and revoked when its process or Chat lifecycle ends. The extension UI protocol is a transport for user approval, not an authorization policy engine. The bundled extension declares schemas and forwards requests; it cannot decrypt profiles, approve origins, classify actions, or choose artifact paths.

### Sensitive assets

- Per-Chat IPC capabilities and approval grants.
- Cookies, authorization headers, storage state, passkeys, OTPs, passwords, API keys, payment data, and user-entered secrets.
- Browser profiles and platform-backed encryption keys.
- Screenshots, snapshots, console output, response bodies, downloads, and reports.
- Local network topology, host services, cloud metadata, and authenticated staging data.
- Chat identity, page/element references, request IDs, and artifact ownership metadata.

## 3. Trust boundaries and enforcement ownership

| Boundary | Untrusted input crossing it | Owner | Enforcement point |
|---|---|---|---|
| Model → pi extension | Tool name and arguments | Extension (shape only), browser host (authority) | Extension applies bounded schemas; host independently validates every field and ignores model safety claims |
| Extension → browser-host IPC | Identity, capability, request ID, action, arguments, cancellation | Browser host | Authenticated/versioned framing, message limits, capability/Chat/process binding, replay rejection, lifecycle state check |
| Approval UI → browser host | User decision and scope | Browser host | Match nonce, Chat, action, target, value hash, origin, scope, and expiry before execution; consume one-shot grants atomically |
| Browser host → Playwright/Chromium | Navigation and interaction commands | Browser host | Destination and action policy runs before each action/request; uncertain classification blocks |
| Chromium → network | DNS answers, redirects, frames, workers, requests, responses | Browser host network policy | Resolve and classify before connection; revalidate redirects/DNS and all request classes; deny unsupported schemes/classes |
| Page → model-visible observation | DOM/ARIA text, console, exceptions, URLs, headers, bodies, metadata | Browser host | Source labels, allowlists, recursive secret filtering, content-type checks, truncation, cursors, and artifact-only binary handling |
| Browser host → filesystem | Artifact names, downloads, profile state | Browser host artifact/profile stores | App-owned root, canonical containment, restrictive permissions, opaque IDs, quotas, atomic writes, symlink rejection |
| Profile store → BrowserContext | Decrypted storage state | Browser host only | Platform-backed key, origin scope and consent checks, in-memory application where supported, zero model-visible return |
| Chat A → Chat B resources | Guessed IDs/capabilities/references | Browser host | Separate contexts, capabilities, registries, buffers, roots, and ownership checks on every lookup |
| Target repository → app host | Project code/config, local server behavior, symlinks | Browser host | Treat repository as hostile; never load project Playwright/config/extensions or place browser files in it |

Signed Kern Studio code, the pinned app-owned Node/Playwright/Chromium runtime, and its launched browser host are the trusted computing base. Chromium is trusted only to execute the signed pinned binary and honor its launch proxy; its page-visible outputs, target repositories, pages, network peers, DNS, external proxies, profiles after use, and all model-proposed arguments remain untrusted.

## 4. Authorization model

Authority is the intersection of all applicable grants; no layer may broaden another layer's grant:

- **Session grant:** unguessable capability bound to one Chat, pi process, browser session, protocol version, and lifetime.
- **Network grant:** exact approved origin plus permitted destination class. A new top-level origin always requires approval.
- **Action grant:** read-only action allowed by deterministic classification, or an exact user approval for a mutation-capable/uncertain action.
- **Test-mode grant (B2):** exact origins, methods/routes, action classes, test-record identifiers, cleanup steps, and expiry. It cannot override network, credential, redaction, or artifact policy.
- **Profile grant (B2):** explicit consent and origins contained by the profile's stored scope.
- **File grant (B2):** opaque, expiring, Chat-owned handle produced by user selection or Chat attachment.

Page text, element labels, HTTP responses, model assertions, prior approval, and successful navigation are never grants. Approval is invalid after any material change to target, value, origin, Chat, scope, or expiry.

## 5. Threats, abuse cases, and required controls

### 5.1 Prompt injection and confused-deputy actions

**Abuse:** A page says to reveal cookies, invoke shell tools, visit another origin, upload a local file, disable policy, or interpret a destructive button as safe. Hidden DOM, accessibility labels, console messages, screenshots, and response bodies may carry the same attack.

**Controls:** Label observations as untrusted evidence; never parse page content as authorization; expose no arbitrary JavaScript evaluation; keep policy deterministic in the host; use semantic identity only to locate an element, not to establish safety; require exact approval for uncertain effects. Other pi tools retain their own approval boundaries and receive no browser capability.

**Residual risk:** Sanitized malicious prose can still influence model reasoning. Host enforcement limits impact, but cannot guarantee correct test conclusions; reports must distinguish observations from conclusions.

### 5.2 Credential and browser-state disclosure

**Abuse:** The model fills a password/OTP/token field, reads a populated secret control, requests cookies/storage/unsafe headers, extracts a token from console/body/query data, or receives a screenshot containing credentials or a QR code.

**Controls:** Reject secret-classified controls and secret-shaped fill values before browser entry; authenticate via paused headed takeover or host-only scoped profile; never return raw cookies, storage, request credentials, or decrypted profile data; filter secret keys and safe-list headers; omit hidden/password values from snapshots; keep screenshots local and opaque unless the user explicitly permits image inspection. Do not log capabilities or secrets.

**Residual risk:** Novel secret formats and secrets rendered as ordinary visible text may evade classifiers. Bounded output, local-only screenshots, explicit inspection consent, and user-visible redaction summaries reduce but do not eliminate this risk.

### 5.3 SSRF, DNS rebinding, redirects, and origin transitions

**Abuse:** URLs target private LAN services, link-local/cloud metadata, IPv4-mapped private IPv6, credential-bearing URLs, malicious DNS that changes after approval, redirects to a privileged class, proxy bypass, popups/frames/workers/WebSockets/service workers that contact denied destinations, or a public page posts mutations cross-origin.

**Controls:** Accept only `http:`/`https:` top-level URLs without credentials; launch the pinned Chromium through an authenticated host-owned loopback proxy; clear inherited proxy configuration and disable QUIC; centrally classify all proxy-resolved addresses; deny private LAN, link-local, multicast, unspecified, mapped-private, metadata, and unsupported schemes by default; approve loopback and public HTTPS origins explicitly; re-resolve and revalidate before connection and on every redirected request; route supported top-level, popup, frame, fetch/XHR, form, WebSocket, beacon, worker, and service-worker traffic through the same policy; constrain passive subresources to safe retrieval in the same network class without injected credentials. A class transition or new top-level origin requires approval or denial.

**Residual risk:** The approved boundary trusts the pinned app-owned Chromium/runtime to honor its launch proxy. A Chromium process compromised by a browser exploit could open a direct socket because Kern Studio does not install a privileged macOS Network Extension or packet-filter helper. OS-level containment of that post-compromise behavior is explicitly out of scope. Browser instrumentation and service-worker behavior can also make evidence incomplete; reports disclose the configured mode and gaps rather than claiming absence.

### 5.4 Mutation, destructive controls, and approval substitution

**Abuse:** A click triggers deletion, a GET endpoint mutates state, a fill auto-submits, a benign element changes before execution, or approval for one value/record is replayed against another.

**Controls:** HTTP method is only one signal. Classify conservatively before execution; uncertain means approval required. Approval preview includes bounded semantic context, masked value, origin/current URL, expected scope, and expiry. Bind and atomically consume approval by nonce, Chat, action, stable target, value hash, origin, and scope. Re-resolve the target and policy immediately before action. B2 test mode uses exact disposable record identifiers and verified cleanup.

**Residual risk:** A target application can hide server-side side effects. One-shot approvals limit scope, but the user must understand the displayed expected effect; verification cannot undo an undeclared side effect.

### 5.5 Cross-Chat leakage and capability theft

**Abuse:** Chat A guesses Chat B's page, request, element, profile, or artifact ID; replays an IPC message; inherits a capability after process replacement; or reads pooled browser state.

**Controls:** Generate cryptographically random capabilities; bind them to Chat and process identity; use separate BrowserContexts, registries, event buffers, artifact roots, and default profile scopes; reject replay, expired capability, unknown version, and calls during shutdown; revoke on `browser_close`, `session_shutdown`, Chat replacement, timeout, crash, and app quit. Never expose capability values in logs/results.

**Residual risk:** A compromise of trusted host memory can access active sessions; OS process hardening and minimizing decrypted lifetime are defense in depth, not isolation from a compromised signed host.

### 5.6 Profile theft, misuse, and persistence

**Abuse:** An attacker copies plaintext profile state, applies it to an unapproved origin/project, recovers it from a temporary file/log, or uses a stale profile after compromise.

**Controls:** B2 requires explicit save/apply consent, platform-backed keys, authenticated encryption, restrictive permissions, origin/project scope, atomic writes, metadata-only inspection, revocation/deletion, versioning, and no plaintext fallback when secure storage fails. Prefer in-memory state application and minimize decrypted lifetime. Profiles are not shared across Chats/projects by default.

**Residual risk:** A permitted compromised origin can abuse its valid session. Users need revocation and retention controls; profile application does not make page content trusted.

### 5.7 Arbitrary upload and local-file exfiltration

**Abuse:** The model supplies `/etc/...`, follows a symlink, reuses another Chat's handle, races path validation, or uploads an oversized/sensitive file.

**Controls:** Accept only a user-selected or explicitly attached opaque handle; bind owner and expiry; open safely after canonical containment, symlink, type, and size checks; reject raw paths and changed files; require action/network approval for upload and resulting request; expose only sanitized metadata.

**Residual risk:** A user can knowingly select a sensitive file. Approval must identify the destination and file metadata without revealing content.

### 5.8 Malicious downloads

**Abuse:** A page downloads executable content, path-traversal filenames, decompression bombs, or content designed to be opened automatically.

**Controls:** Quarantine beneath the per-Chat artifact root using host-generated names; canonicalize containment; impose quotas and size limits; never execute, preview, or auto-open; return sanitized name/type/size metadata only; require explicit user export.

**Residual risk:** Exported files may be malicious; the OS/user security boundary applies after explicit export.

### 5.9 Artifact traversal, disclosure, and exhaustion

**Abuse:** Logical screenshot names use `../`, symlinks escape the root, opaque IDs cross Chats, bodies fill disk, or reports expose secrets.

**Controls:** Host chooses paths under `<app-data>/sessions/<chat-id>/browser`; canonical containment and ownership checks apply on create/read/export/delete; opaque unguessable references replace paths; restrictive permissions, quotas, cursors, content limits, expiry, and bounded cleanup apply; target repositories are never artifact roots. Apply the same redaction boundary when previewing and reporting.

**Residual risk:** Screenshots and binary artifacts cannot be reliably content-redacted. Keep them local and require explicit inspection/export.

### 5.10 Evidence integrity and misleading diagnostics

**Abuse:** HTTP 500 is mislabeled as transport failure; cancellation is claimed to be AbortController without proof; missing service-worker events are treated as no traffic; action/event correlation associates unrelated requests.

**Controls:** Stable request/action IDs and monotonic timing; distinct dispositions for response, transport failure, cancellation, block, and timeout; status recorded for completed HTTP errors; intent labeled unknown when not provable; service-worker mode and completeness recorded; bounded correlation windows supplement, not replace, IDs. Preserve evidence append-only where practical.

**Residual risk:** Browser instrumentation cannot prove all causal relationships. Reports state uncertainty explicitly.

### 5.11 Browser/sidecar compromise and lifecycle failure

**Abuse:** Malicious content exploits Chromium; sidecar crashes mid-action; cancellation races completion; app quit leaves an authenticated process; automatic restart repeats a mutation.

**Controls:** Pin and promptly update runtime/browser; use app-owned binaries and signing; no remote debugging or arbitrary extensions; supervise process and context lifecycle; forward cancellation; make close idempotent; revoke capability before teardown; do not automatically replay mutation-capable requests; restart into no-authority/no-page state unless the ADR proves safe restoration; verify orphan cleanup in packaged tests.

**Residual risk:** Chromium zero-days remain possible. A compromised Chromium may bypass the configured proxy with direct sockets; this is an accepted product risk under the approved trusted-runtime boundary. Platform sandboxing, least filesystem privilege, rapid pinned-browser updates, and limited session lifetime are defense in depth, not an OS network-containment guarantee.

## 6. Fail-closed matrix

| Failure | Required behavior |
|---|---|
| Browser host unavailable/unhealthy | Return stable retryable host error; execute nothing |
| Unknown IPC version, malformed/oversized message | Reject and audit non-secret metadata; do not launch/restart action |
| Missing, expired, replayed, or mismatched capability | Reject; revoke session on repeated authentication failure |
| Approval dismissed, timed out, malformed, expired, or mismatched | Return blocked/approval-required; execute nothing |
| DNS failure, mixed/changed answers, classification uncertainty, redirect uncertainty | Block request/navigation |
| Policy engine error or unsupported request/action type | Block; never default to safe |
| Cancellation | Stop pending work, mark cancelled only when established, restore known state or close context |
| Sidecar/Chromium crash | Revoke capability, close context/artifact writers, return error; never replay mutations |
| Secure storage unavailable/corrupt | Profile save/apply fails; no plaintext fallback |
| Redaction/sanitization failure | Withhold model-visible payload; retain only safe error metadata |
| Artifact containment/permission/quota failure | Refuse write/read/export; do not fall back to repository or temp directory |
| App/Chat/pi shutdown or replacement | Revoke first, cancel actions, close pages/context/IPC/process, reconcile orphan on next launch |
| Evidence buffer overflow | Apply documented bounds/drop policy and mark evidence incomplete |

## 7. Security logging and privacy

Audit records may contain timestamp, Chat-scoped pseudonymous ID, action class, normalized origin, policy outcome/reason code, approval scope ID, event/artifact opaque ID, and lifecycle state. They must not contain capabilities, approval nonces, credentials, cookies, storage state, secret values, unsafe headers, raw request bodies, or unsanitized page text. URLs must have userinfo rejected and sensitive query values filtered. Retention is bounded and separate from encrypted profiles.

## 8. Required security verification

Before B1 acceptance, automated or packaged integration checks must prove:

- cross-Chat capability, context, storage, event, element-reference, and artifact isolation;
- malformed, oversized, replayed, expired, wrong-process, and shutdown IPC rejection;
- denied schemes, credential-bearing URLs, private/link-local/metadata/mapped-private destinations, rebinding, redirects, and new origins are blocked before connection;
- uncertain mutation and changed/expired approvals cannot execute;
- password/OTP/token controls and secret-shaped values never enter model-visible channels;
- artifact traversal, absolute paths, symlinks, quota overflow, and cross-Chat IDs fail closed;
- HTTP errors, transport failures, cancellations, policy blocks, and incomplete evidence remain distinct;
- cancellation, browser crash, Chat replacement, and app quit leave no orphan browser/sidecar process;
- target repositories remain byte-for-byte free of Playwright dependencies and browser artifacts.

B2 adds profile encryption/scope/revocation, headed takeover, upload-handle race/ownership, download quarantine, test-mode expiry, and cleanup verification tests. B3 adds scenario-schema rejection, failure capture, report redaction/schema validation, retention, and deletion isolation.

## 9. B0 blockers for the architecture ADR

B1 is blocked until the packaged spike and ADR resolve and prove:

1. Exact pinned Node, Playwright, and Chromium versions and the supported macOS target.
2. Sidecar signing, Tauri `externalBin` naming, browser location, offline install/update, measured size/startup impact, and browser security-update ownership.
3. IPC transport, peer/process authentication, capability generation/storage, framing/message limits, replay defense, cancellation, event streaming, health, restart, and revoke-before-shutdown ordering.
4. Platform sandbox and least-privilege posture, including filesystem visibility, allowlisted environment inheritance, authenticated proxy handling, QUIC disablement, and the accepted lack of OS-level direct-socket containment after Chromium compromise.
5. Fail-closed proxy enforcement for normal Chromium traffic and the shared IP-classification implementation, including denied ranges, DNS rebinding/mixed-answer behavior, and redirect revalidation.
6. Exact action-classification and approval-binding algorithm, including TOCTOU revalidation immediately before execution.
7. Artifact root derivation, permissions, canonicalization, opaque-reference format, quotas, retention defaults, and crash-safe cleanup.
8. Redaction implementation and limits, especially screenshots, URLs, console values, response bodies, and failure behavior when sanitization cannot complete.
9. Packaged proof of two isolated contexts, headed/headless launch, ARIA snapshot, screenshot, network/console evidence, cancellation, crash cleanup, and clean shutdown.
10. Windows/WSL execution remains explicitly deferred; the ADR must state that browser tools are unavailable there until an equivalent host-boundary decision passes review.

These are blockers, not implementation-time defaults. They are evaluated under the approved proxy boundary: privileged OS-level network containment after compromise of the pinned runtime is not required. A maintained non-Node host is acceptable only if the same controls and packaged proof pass.

## 10. Residual-risk ownership and review

- **Browser/runtime vulnerabilities:** release owner; pinned updates and packaged regression checks.
- **Policy and redaction gaps:** browser-host owner; security tests block release.
- **User-approved destructive effects:** product owner; exact previews, narrow grants, and verified cleanup.
- **Sensitive visual/binary artifacts:** user and artifact-store owner; local-by-default with explicit inspection/export.
- **Incomplete or uncertain evidence:** reporting owner; disclose limitations and prohibit stronger conclusions.

Review this threat model whenever the browser runtime, IPC transport, destination classes, approval schema, profile format/key storage, upload/download handling, artifact preview/export, Global Chat exposure, or Windows/WSL architecture changes.
