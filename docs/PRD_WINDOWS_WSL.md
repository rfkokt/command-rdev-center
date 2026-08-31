# PRD — Windows Support via WSL2

**One sentence:** Ship Kern Studio as a native Windows desktop app while running its coding-agent toolchain inside WSL2, using the same React, Rust, and product codebase as macOS so normal feature work reaches both platforms by default.

**Owner:** garcia · **Status:** Draft · **Date:** 2026-08-31

---

## 1. Problem

Kern Studio currently assumes a macOS/Unix environment for executable discovery, shell commands, paths, process groups, PTY behavior, and helper tools. A full native Windows execution backend would require parallel implementations for PowerShell/cmd, Windows paths, ConPTY, and Windows process lifecycle management.

The product needs Windows support without maintaining two applications or duplicating every feature. WSL2 already provides the Unix environment expected by `pi`, Git, Node, Graphify, shell pipelines, and project tooling.

## 2. Product decision

On Windows:

- The React UI and Tauri/Rust host run as a native Windows `.exe`.
- Agent and development commands run inside a configured WSL2 distribution through `wsl.exe`.
- Projects are stored in the WSL filesystem by default.
- The macOS and Windows editions are builds of one repository, not separate products.
- Platform-specific code is limited to the execution, path, installation, and packaging boundaries.

```text
Kern Studio.exe (Windows UI + Tauri host)
  └─ wsl.exe --distribution <distro> --cd <linux-cwd> -- <command> <args...>
       ├─ pi --mode rpc
       ├─ git
       ├─ graphify
       ├─ node / pnpm
       └─ project pipeline commands
```

Running the full Linux GUI under WSLg is explicitly rejected for the product build. It remains acceptable only as a developer experiment.

## 3. Goals

- Provide a native Windows desktop experience backed by WSL2 execution.
- Preserve the existing pi RPC, worktree, diff, Graphify, terminal, Kanban, and pipeline behavior.
- Keep one shared feature codebase for macOS and Windows.
- Make cross-platform behavior the default for product features rather than an optional follow-up.
- Clearly diagnose missing WSL, distro, dependency, path, and process failures.
- Deliver platform-specific installers and updater artifacts from the same release version.

## 4. Non-goals

- Running `pi`, pipelines, or project shells directly in PowerShell or `cmd.exe`.
- Supporting Windows without WSL2.
- Maintaining separate Windows and macOS feature branches.
- Automatically installing arbitrary project dependencies.
- Supporting projects on network shares in the first release.
- Linux desktop packaging in this phase; the WSL execution design should not prevent it later.

## 5. Target environment

### Windows host

- Windows 11 with WSL2 and WSLg-capable system components.
- Native Tauri WebView2 runtime.
- `wsl.exe` available from Windows.
- One configured WSL distribution; Ubuntu is the tested default.

### WSL guest

Required commands:

- `bash`
- `git`
- `pi`

Feature-dependent commands:

- `node` and the project's package manager
- `graphify`
- `cargo`, Python, or other project toolchains
- preview helpers such as Poppler

The app checks dependencies and reports exact remediation commands. It does not silently modify the distro.

## 6. User experience

### 6.1 First launch on Windows

1. Detect `wsl.exe`.
2. List installed WSL distributions.
3. Ask the user to select a default distribution if more than one usable distro exists.
4. Verify that the selected distro is WSL2 and can execute a non-interactive command.
5. Check required commands inside the distro.
6. Show a compact readiness screen with pass/fail status and install guidance.
7. Persist the selected distro in app settings.

If WSL is missing, the app shows Microsoft's standard install command and does not expose a broken workspace.

### 6.2 Importing projects

The recommended project location is the WSL filesystem:

```text
/home/<user>/projects/<repo>
```

Windows displays that location through:

```text
\\wsl$\<distro>\home\<user>\projects\<repo>
```

Projects under `/mnt/c`, `/mnt/d`, and similar mounts are allowed with a performance warning because Git, `node_modules`, and file watchers can be slower across the Windows/WSL filesystem boundary.

The canonical project identity is the Linux path plus distro, not a translated Windows path alone:

```json
{
  "execution": "wsl",
  "distro": "Ubuntu",
  "path": "/home/rifki/projects/example"
}
```

### 6.3 Daily operation

- Chat starts `pi --mode rpc` inside the selected distro and project/worktree directory.
- RPC remains JSONL over stdin/stdout; the Tauri host bridges Windows pipes to `wsl.exe`.
- Git diff, worktree management, Graphify, project search, terminal commands, and pipelines execute in the same distro.
- Dev-server URLs remain reachable from the Windows webview/browser through WSL2 localhost forwarding.
- Opening a project in an editor uses the editor's WSL integration, for example `code --remote wsl+Ubuntu <path>` where available.

## 7. Shared feature delivery

Yes: macOS and Windows can receive new features together because there is one application codebase and one product model.

### 7.1 Shared by default

These remain platform-neutral and should not be duplicated:

- React screens, components, state, and styling
- Tauri command contracts and frontend TypeScript types
- Chat event handling and pi RPC protocol
- Diff rendering
- Kanban and pipeline UI
- Graph status and research UI
- Settings schema except explicitly platform-specific fields
- Domain rules, validation, and persisted data formats

### 7.2 Platform boundary

Only host integration may vary:

| Capability                 | macOS              | Windows                                                             |
| -------------------------- | ------------------ | ------------------------------------------------------------------- |
| Command execution          | local Unix process | `wsl.exe` into selected distro                                      |
| Canonical project path     | macOS path         | distro + Linux path                                                 |
| Process termination        | Unix process group | terminate `wsl.exe` launcher and the identified Linux process group |
| Open in editor             | local editor CLI   | editor WSL integration                                              |
| Tool installation guidance | Homebrew/manual    | install inside WSL distro                                           |
| Packaging                  | `.dmg`/`.app`      | `.msi`/installer                                                    |
| Updater artifact           | macOS target       | Windows target                                                      |

Feature code must call a shared execution service rather than invoke platform shells directly. The minimum interface covers:

- execute a command with argument boundaries preserved
- spawn and supervise a long-running process
- write to stdin and stream stdout/stderr
- stop a process tree
- resolve/check an executable
- normalize and validate a project path
- reveal/open a path using the host platform

This is a boundary, not a second feature implementation.

### 7.3 Definition of done for future features

A feature is complete only when:

- Shared behavior passes on macOS and Windows CI, unless explicitly marked platform-only.
- New process or filesystem behavior uses the shared execution/path boundary.
- No shell command is built by concatenating untrusted text.
- Platform-specific behavior has one focused test per supported platform.
- Both platform artifacts are produced from the same version/tag.

A platform-specific feature is allowed only when its product value is inherently platform-specific and the limitation is visible in the UI and release notes.

## 8. Functional requirements

### 8.1 WSL detection and settings

- **Must** detect whether WSL is installed and runnable.
- **Must** enumerate installed distros and identify the configured default.
- **Must** persist distro selection.
- **Must** revalidate the distro after settings changes or execution failure.
- **Should** show whether required and optional tools are available.
- **Won't** install a distro without explicit user action.

### 8.2 Command execution

- **Must** pass commands and arguments without embedding user input into a shell string.
- **Must** support explicit shell mode only for saved pipeline steps that require shell syntax.
- **Must** set the Linux working directory before starting a command.
- **Must** preserve structured environment values safely.
- **Must** stream pi RPC and terminal output without corrupting UTF-8 or JSONL framing.
- **Must** stop the relevant Linux process tree when a run is cancelled.
- **Must** distinguish missing command, missing path, distro unavailable, non-zero exit, and cancellation.

### 8.3 Paths and isolation

- **Must** store WSL project identity as `{distro, linuxPath}`.
- **Must** reject path traversal outside registered projects/worktrees using Linux canonical paths resolved inside WSL.
- **Must** keep each Chat's worktree in the same Linux filesystem as its repository when possible.
- **Must** preserve the existing one-writer-per-worktree rule.
- **Must** prevent one distro from being silently substituted for another.
- **Should** translate paths only for display, file dialogs, and host integrations.

### 8.4 Updates and releases

- **Must** build macOS and Windows artifacts from the same commit and semantic version.
- **Must** publish platform-specific updater artifacts and signatures under one release manifest or equivalent target-aware manifests.
- **Must** prevent a Windows client from receiving a macOS artifact and vice versa.
- **Should** release both platforms together after their required checks pass.
- **Should** allow an emergency platform-specific hotfix without forking the product codebase.

## 9. Technical approach

### 9.1 Execution context

Add an execution context to registered project/session data:

```ts
type ExecutionContext = { kind: "local" } | { kind: "wsl"; distro: string };
```

Existing macOS projects default to `local`. Windows projects use `wsl`.

The Rust backend owns command construction. For direct execution it invokes `wsl.exe` with separate arguments. Shell mode invokes `bash -lc` only when shell syntax is intentionally required.

### 9.2 Process identity and cancellation

The launcher records both:

- the Windows `wsl.exe` child process
- the Linux process-group/session identifier returned by a small startup wrapper

Cancellation first requests graceful Linux termination, then force-kills the Linux process group after the existing timeout. Killing only `wsl.exe` is insufficient because descendants may survive inside the distro.

No persistent daemon is introduced in the first version. Add one only if measurements show that per-command `wsl.exe` startup or lifecycle tracking is inadequate.

### 9.3 Path validation

Windows host canonicalization cannot be the authority for WSL paths. Validation runs inside the selected distro using Linux canonical paths. Existing registered-project and worktree isolation rules remain authoritative after path resolution.

Frontend-visible paths are opaque identifiers plus display text; they are not trusted execution paths.

### 9.4 Storage compatibility

Persisted records gain optional execution metadata with backward-compatible defaults. Existing macOS records continue to load as local projects. No separate Windows storage format is created.

## 10. Rollout

### Phase W1 — compatibility foundation

- Introduce the shared execution context and command boundary.
- Route existing macOS behavior through the local implementation without changing behavior.
- Remove direct macOS assumptions from shared call sites.
- Add Windows and macOS CI compile/test jobs.

### Phase W2 — Windows onboarding and projects

- Add WSL/distro readiness checks and settings.
- Add WSL project import and canonical path validation.
- Support worktree creation, repository metadata, Git status, and diff inside WSL.

### Phase W3 — agent and terminal parity

- Run pi RPC through WSL with streaming and approvals.
- Support cancellation, restart, session resume, terminal, and dev runner.
- Verify localhost forwarding and editor opening.

### Phase W4 — pipelines, tools, and distribution

- Run pipeline and Graphify commands inside the same execution context.
- Replace macOS-only tool discovery with execution-context checks and guidance.
- Produce signed Windows installer/updater artifacts.
- Run end-to-end smoke tests and publish a beta.

## 11. Acceptance criteria

A Windows beta is ready when:

- A clean Windows 11 machine with WSL2 can install and launch Kern Studio.
- The onboarding flow selects a distro and identifies missing required tools.
- A WSL-hosted Git project can be imported without manually entering a Windows path.
- A Chat creates an isolated worktree and starts `pi --mode rpc` in it.
- Streaming text, tool calls, approval dialogs, cancellation, and resume work.
- Diff, source control, file search/preview, Graphify, terminal, dev runner, and pipeline work against the same project.
- Closing/cancelling a run leaves no known orphan Linux process.
- Isolation tests prove that sibling registered projects remain inaccessible.
- A release tag produces installable macOS and Windows artifacts at the same version.
- The updater selects the correct artifact for each operating system.

## 12. Risks and mitigations

| Risk                                         | Mitigation                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `/mnt/c` filesystem performance              | Recommend WSL filesystem; show a warning rather than blocking                               |
| Windows and Linux path confusion             | Persist distro + Linux path as canonical identity; translate only at boundaries             |
| Orphan processes after cancelling `wsl.exe`  | Track and terminate the Linux process group, then verify exit                               |
| Shell quoting or command injection           | Prefer direct argv execution; restrict explicit shell mode to intentional pipeline commands |
| Tool installed on Windows but missing in WSL | Run dependency checks inside the selected distro and show exact guidance                    |
| Different distros behave differently         | Test Ubuntu first; label others best-effort until added to compatibility CI                 |
| Platform drift                               | Shared domain code, same-version releases, and mandatory CI for both targets                |
| Updater serves wrong binary                  | Target-aware signed artifacts and per-platform update tests                                 |
| WSL localhost forwarding differences         | Test dynamically selected ports and show a diagnostic/fallback host address                 |

## 13. Success metrics

- At least 90% of non-platform-specific source changes are shared across macOS and Windows.
- No routine feature requires separate macOS and Windows UI implementations.
- Core smoke tests pass on both platforms before a normal release.
- A new shared UI/domain feature can ship to both platforms from one commit and version tag.
- Windows users can complete import → Chat → diff → pipeline without opening a separate WSL terminal after onboarding.

## 14. Open questions

1. Should the first beta support only Ubuntu, or allow other distros with a best-effort warning? Proposed: Ubuntu tested, others best-effort.
2. Should Windows project selection use a WSL-native browser or a Windows folder picker limited to `\\wsl$`? Proposed: an app-native WSL project browser backed by Linux directory listing.
3. Should updater publication wait for both platforms, or publish each artifact as soon as its job passes? Proposed: one coordinated stable release; independent beta artifacts are acceptable.
4. Should projects under `/mnt/c` be warning-only or blocked for Node-heavy repositories? Proposed: warning-only until real performance data justifies stronger policy.
