# ADR-0006: Native browser automation host boundary

**Status:** Accepted · **Date:** 2026-09-02

## Context

The [browser automation PRD](../PRD_NATIVE_BROWSER_AUTOMATION.md) requires Playwright without changing target repositories. The [threat model](../SECURITY_NATIVE_BROWSER_AUTOMATION.md) makes the app-owned host the authority boundary. B0 had to select and package a runtime, prove its lifecycle, and settle whether network policy required privileged OS containment.

## Decision

Use an app-owned Node 22.18.0 sidecar with Playwright 1.55.0 and its pinned Chromium revision 1187. `src-tauri/browser-host` is an isolated locked package; Playwright is not a root or target-project dependency. Node, Playwright, Chromium, and the signed browser host form the trusted computing base.

Use an authenticated host-owned loopback proxy as the network enforcement boundary for normal browser traffic. Chromium launches with that proxy, inherited proxy variables cleared, QUIC disabled, and loopback proxy bypass disabled. The proxy resolves destinations itself, rejects mixed-class answers, classifies addresses before connection, and revalidates redirected requests. It permits approved loopback HTTP and optionally public HTTPS on port 443; it denies private/LAN, link-local, metadata, multicast, unspecified, mapped-private, credential-bearing URLs, unsupported schemes, and unvalidated tunnels.

This boundary trusts the pinned app-owned Chromium/runtime to honor launch configuration. OS-level direct-socket containment after compromise of Chromium is an accepted residual risk and is out of scope. Kern Studio will not add a macOS Network Extension, PF/root helper, or private sandbox profile for B0–B3. Platform sandboxing, short sessions, and rapid pinned-browser updates remain defense in depth.

The production transport is an app-created Unix-domain socket on macOS, with a Windows equivalent deferred to a later ADR. Messages use length-bounded versioned envelopes `{version,id,sessionId,capability,action,args}`. Rust generates a 256-bit per-Chat capability, binds the sidecar process group and Chat identity, never logs the capability, rejects duplicate request IDs, and fails closed on unknown versions, malformed/oversized frames, identity mismatch, replay, or calls during shutdown.

Cancellation addresses an active request ID and never replays work. Shutdown ordering is: revoke capability, reject new calls, cancel work, close pages/contexts/browser/proxy, close IPC, terminate, then force-kill the process group after a bounded grace period. Restart creates a new capability and empty state. Stable terminal statuses are `ok`, `approval_required`, `blocked`, `timeout`, `cancelled`, and `error`.

## Security and lifecycle contracts

- **Chat isolation:** one capability, BrowserContext, reference namespace, event buffers, and artifact root per Chat. Every lookup verifies ownership.
- **Approvals:** one-use random nonce bound to capability/session, action, stable target generation, value hash, current/destination origins, normalized method/route scope, and monotonic expiry; target and binding are recomputed immediately before execution.
- **Artifacts:** `<app-data>/sessions/<opaque-chat-id>/browser`, restrictive permissions, host-generated names, no-follow containment, opaque references, ownership checks, atomic writes, quotas, expiry, and crash reconciliation.
- **Redaction:** structured allowlists, recursive secret filtering, URL userinfo/query filtering, content-type and byte bounds, and untrusted-source labels. Sanitizer failure withholds output.
- **Sandbox:** no remote debugging, target-project browser config/plugins, arbitrary JavaScript tool, inherited proxy, arbitrary filesystem paths, or repository artifacts.
- **Profiles:** B2 uses platform-backed encryption, origin/project scope, explicit consent, and no plaintext fallback.

## Packaging

Tauri bundles the exact Node runtime, locked host modules, and app-owned Chromium as resources. They are resources rather than `externalBin` because the executable is an exact Node runtime with fixed script/module/browser arguments. `PLAYWRIGHT_BROWSERS_PATH` points inside app-owned resources and works without a first-run download. The updater must ship runtime and browser atomically and reject incompatible partial versions. macOS arm64 is first; Windows/WSL browser tools remain unavailable until a separate ADR repeats packaging, sandbox, proxy, secure-storage, signing, and orphan checks.

Release signing/notarization uses owner credentials in the release pipeline. B0 uses an unsigned/ad-hoc packaged smoke to validate architecture and records signing as an operational release requirement rather than a local implementation gate.

## B0 evidence (macOS arm64, 2026-09-02)

- Exact Node 22.18.0 host tests cover capability/session mismatch, replay, cancellation, two-context cookie/localStorage isolation, ARIA snapshot, screenshot, console/network evidence, and clean shutdown.
- Proxy tests cover privileged ranges, IPv4-mapped private addresses, mixed DNS answers, authentication, credential-bearing URLs, denied destinations before connect, and redirect revalidation.
- App-owned Chromium smoke succeeds against a loopback fixture without a target-project install.
- The ad-hoc `.app` bundles exact Node, Playwright, and Chromium; packaged resources launch offline, answer health, shut down, and leave no orphan host.
- Packaged app size is approximately 826 MiB; packaged browser resources are approximately 678 MiB. First launch needs no browser download; startup timings are recorded by the smoke output.
- Frontend build and Rust supervision tests pass. Headed launch uses the same packaged Chromium and lifecycle with `KERN_BROWSER_HEADED=1`; release signing/notarization remains a release-pipeline check requiring owner credentials.

## Consequences

B0-02 and B0-03 are complete under the approved proxy boundary. B1 may implement production IPC, Chat lifecycle, policy, approvals, artifacts, tools, and evidence without inventing architecture. A future requirement to contain direct sockets from a compromised Chromium process is a new product/security architecture decision requiring privileged macOS capabilities and must amend this ADR.
