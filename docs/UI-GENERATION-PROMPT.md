# Prompt — Generate Phase 1 UI for Command rdev Center

Paste-ready prompt for an AI UI generator / design agent. Built from `docs/TASKS.md` (M1–M6) + `docs/PRD.md` §6.

---

## Paste this

Build the Phase 1 UI for **Command rdev Center** — a local-first, single-user Tauri v2 desktop app (React + Vite + TypeScript) that launches `pi` (a coding agent) in RPC mode behind a custom chat UI. Each git chat runs in its own ephemeral worktree. No server, no cloud, no telemetry. The only user is a developer (me), so optimize for density and speed over consumer polish.

### Stack & constraints
- **React + Vite + TypeScript**, rendered in Tauri v2's system webview. No Next.js, no SSR, no router.
- **No CSS framework / UI kit is installed.** Prefer plain CSS modules or a single `App.css` with CSS variables (design tokens). Do NOT add Tailwind, shadcn, MUI, or any dependency — keep the ~3–10 MB Tauri bundle small. If a component genuinely needs one tiny dependency, name it and justify in one line.
- **Data flows via Tauri:** frontend calls `invoke<T>("command")` for request/response, and listens to `listen("event", cb)` for streamed updates. Treat these as the data source — do not mock freely, show realistic loading/streaming/empty/error states.
- **Streaming-first.** The assistant's reply token-streams in; tool calls render live as they happen; bash output streams line-by-line. Every surface that shows agent output must assume partial/incomplete data and update in place — never block on "finished".

### Aesthetic — the Bugatti voice
This app borrows **Bugatti's marketing design language** wholesale. It is the most austere luxury surface in its category: a near-pure-**black canvas** holding white **UPPERCASE letterspaced** display type. There is **no accent color**, no surface-card decoration, no shadows, no gradients, no chrome. Visual emphasis comes from **size, letter-spacing, case, and family contrast — never weight** (the system has no bold; everything is weight 400). The result reads as engineered precision, not a consumer SaaS template.

One adaptation: Bugatti anchors every page in full-bleed automotive photography. This is a functional tool, so **drop the photography mandate** — but keep the *restraint* behind it: empty black space is intentional, it lets the work breathe. Compressing whitespace to "fit more" breaks the brand contract (less = more). What carries the voltage here is the agent's output itself (code, diffs, tool calls), rendered with the same discipline.

**The unbreakable typeface trinity.** Three families, split strictly by function — never blur the roles:
1. **Bugatti Display** → all display headlines (the app wordmark, section heads, empty-state titles). UPPERCASE, wide letter-spaced.
2. **Bugatti Text Regular** (a *serif*) → all running body prose — including the **assistant's streaming chat reply**. Sentence-case, standard tracking. The serif body is deliberate editorial voice; it sets the app apart from all-sans dev tools.
3. **Bugatti Monospace** → button labels, navigation, captions, dates, tool names, file paths, bash output, the composer when idle — anywhere a "precision-machined" feel matters. UPPERCASE, 2–2.5px tracking.

**Font fallbacks** (the licensed Bugatti faces aren't public — use these open-source substitutes; they preserve the three-family split):
- Bugatti Display → **Saira Condensed** (weight 400) + letter-spacing.
- Bugatti Text Regular → **Cormorant Garamond** (regular) or **EB Garamond**.
- Bugatti Monospace → **JetBrains Mono** or **IBM Plex Mono** (weight 400).
Fallback-of-fallbacks (if a custom face fails to load): Display → `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`; Text Regular → `Garamond, "Times New Roman", serif`; Monospace → `ui-monospace, "SF Mono", "Cascadia Mono", monospace`.

### Design tokens — define these once, reference by token, never inline hex

**Colors** (monochrome + one link only):
- Canvas `{colors.canvas}` `#000000` — the page floor.
- Surface soft `{colors.surface-soft}` `#0d0d0d` — spec table rows, dense data.
- Surface card `{colors.surface-card}` `#141414` — tool-call cards, newsroom-style containers.
- Surface elevated `{colors.surface-elevated}` `#1f1f1f` — nested cards only.
- Hairline `{colors.hairline}` `#262626` — 1px dividers, table rows, card outlines.
- Hairline strong `{colors.hairline-strong}` `#3a3a3a` — the *underline-only* input borders.
- On-dark `{colors.on-dark}` `#ffffff` — all headline / primary text.
- Body `{colors.body}` `#cccccc` — running text (slightly cooler than pure white).
- Muted `{colors.muted}` `#999999` · Muted-soft `{colors.muted-soft}` `#666666` — secondary metadata (mtimes, kinds, captions).
- Link `{colors.link}` `#c3d9f3` — **the only non-monochrome color in the entire system**; reserved strictly for inline anchor links. Do not invent a brand-blue or accent for active states — active = on-dark on surface-card, not a new hue.

**Typography scale** (all weight 400 — there is no bold in this system):
| Token | Size | LH | Tracking | Face / use |
|---|---|---|---|---|
| `display-xl` | 64 | 1.1 | 4px | Hero/empty-state h1 — Display, uppercase |
| `display-lg` | 48 | 1.15 | 3px | Section heads — Display, uppercase |
| `display-md` | 32 | 1.2 | 2px | Model/sub-section heads — Display |
| `display-sm` | 24 | 1.3 | 1.5px | Card titles — Display |
| `wordmark` | 14 | 1.0 | **6px** | The app wordmark — Display, widest tracking |
| `title-md` | 20 | 1.3 | 0 | Card titles, job-style rows |
| `body-md` | 16 | 1.5 | 0 | Body paragraphs — Text Regular serif (**this is the assistant chat prose**) |
| `body-sm` | 14 | 1.5 | 0 | Fine print, legal — Text Regular |
| `button` | 14 | 1.0 | 2.5px | Button labels — Monospace, uppercase |
| `nav-link` | 12 | 1.4 | 2px | Nav, top-bar labels — Monospace, uppercase |
| `caption-uppercase` | 11 | 1.4 | 2px | Captions, dates, tool-name labels, status pills — Monospace, uppercase |

**Spacing** (4px base): `xxs` 4 · `xs` 8 · `sm` 12 · `md` 16 · `lg` 24 · `xl` 40 · `xxl` 80 · `section` 120 (between major bands — the whitespace is part of the brand, don't compress it).

**Shapes:** radius is binary. `{rounded.none}` `0px` for **everything** — cards, photos, inputs, spec cells, tool-call containers, dialogs (rectangular, not consumer-rounded). `{rounded.pill}` `9999px` for **buttons only**; `{rounded.full}` for circular icon buttons. Rounded cards read as consumer-tech — keep them square.

**Elevation:** no shadows, no glassmorphism, no gradients. Depth = hairline borders + the one-step surface-card tone on black. A streaming tool call rises via `surface-card` background, not a drop shadow.

**Motion:** minimal. A subtle pulse for "streaming", a soft fade for new tool-call blocks, no page transitions. Keyboard-first where it matters (Enter to send, Shift+Enter newline, Esc to close dialogs, `/` to focus search).

### The screens (Phase 1 only)

**1. Project launcher (`ProjectList`)**
- Grid/list of ~21 real projects under a configurable root, sorted newest-first by mtime. Each row is a `surface-card` (or hairline-divided row) with `{rounded.none}` corners: project name in `{typography.title-md}`, relative path in `{colors.muted}` Body, small **stack badges** rendered as `category-tag` labels (`{typography.caption-uppercase}`, Monospace, no fill, no border — the type IS the tag) for git / node / rust / java (detected from `.git`, `package.json`, `Cargo.toml`, `pom.xml`), and a relative timestamp ("2H AGO", uppercase caption).
- **Search (`text-input`):** transparent, underline-only, at top — filters live on name + path (fuzzy preferred). Empty state when filter matches nothing: a `display-md` UPPERCASE headline (e.g. "NO MATCHES") on black, brand-correct. Loading state while scanning.
- Non-git projects get a muted "NOT ISOLATED" `category-tag`. Clicking a project opens a new chat tab.
- **Top nav (`top-nav`):** transparent bar overlaid on the canvas, no fill, no border. Centered **wordmark-display** — "COMMAND RDEV CENTER" in Bugatti Display 14px, **6px letter-spacing** (the widest tracking in the system, same treatment as the Bugatti wordmark). Left: a "MENU"-style label only if needed; right: the default `MODEL · THINKING` from config in `{typography.nav-link}` (Bugatti Monospace, 12px, 2px tracking, muted). The wordmark is the brand element; everything else recedes.

**2. Chat view (`ChatView`)**
- Vertical scroll of messages: user (right-aligned or distinct bubble) and assistant (left/full-width, streaming text appended token-by-token). **Assistant reply prose = Bugatti Text Regular serif** (`{typography.body-md}`, sentence-case, no tracking) — the editorial voice. Assistant **thinking** deltas render as collapsed/muted italic blocks distinct from the spoken reply. The user's own message may use the same serif or a muted variant.
- **Tool calls render inline, live** as `surface-card` (`{colors.surface-card}`) cards with `{rounded.none}` corners and a hairline outline: `read`, `bash`, `edit`, `write`. Tool name + summary in `{typography.caption-uppercase}` (Monospace, 11px, 2px tracking); detail (file content, command, diff hunks) in Monospace. `bash` cards stream stdout/stderr live; `edit`/`write` cards show a mini diff (added/removed lines) when expanded. Depth = the `surface-card` tone on black, **no shadow**. A subtle pulse while running, settled state at `toolcall_end`.
- **Composer (`text-input`):** transparent background, **underline-only** border (`{colors.hairline-strong}`, thickens to white on focus), 44px height, `{typography.body-md}`. Enter sends / Shift+Enter newline; `@` opens the **FilePicker** (fuzzy file search; selecting injects the path). The send action and **Abort** are `button-primary` (transparent, 1px white outline, `{rounded.pill}`, Monospace label, 2.5px tracking) — Abort replaces Send while a turn streams. A small "steer" `button-primary` to inject a mid-turn message.
- A top-of-chat controls row: **model** + **thinking-level** dropdowns (`{typography.caption-uppercase}` labels, underline-only inputs) populated via RPC, switchable mid-session without restart. Plus the project name + a "NOT ISOLATED" `category-tag` if non-git.
- Tabs in the global header for multiple open chats; switching tabs keeps background chats mounted (hidden) so streaming never dies on unfocus. Active tab = on-dark text on a hairline underline; idle tabs = `{colors.muted}` (no accent color).

**3. Approval dialog (`ApprovalDialog`)**
- Modal overlay (never a browser `confirm`) — `{colors.surface-card}`, `{rounded.none}`, hairline outline, **no shadow**. Shows the exact dangerous command/prompt the agent wants to run in `{typography.caption-uppercase}` / Monospace, with context (which tool, which file if any). Two `button-primary` actions (transparent, 1px white outline, pill): **BLOCK** (default, safe) and **ALLOW**. Emphasis between them is position/label, **not color** — the system has no accent, so do not make Allow green or Block red. If the RPC request carried a `timeout`, surface the deadline in `{typography.caption-uppercase}`; default to Block on expiry.
- The app **never** auto-resolves; only the user's click answers. Dialog must trap focus, be Esc-closible to Block, and block interaction with the chat behind it.

**4. Reliability surfaces**
- **Toasts** (bottom-right) for errors and transient notices, auto-dismiss, stacked, capped.
- **Drive-detached state:** if the project's drive unmounts mid-chat, freeze the chat (no kill/retry loop), show a non-blocking "drive detached — reconnect" banner, resume when the drive returns.
- **Agent-stopped state:** if the `pi` subprocess crashes, show "agent stopped" with a **Restart** action. The app itself never hard-crashes.

### Deliverables
- Update the existing components in `src/components/` (`ProjectList`, `ChatView`, `ToolCall`, `ApprovalDialog`, `FilePicker`) and `src/App.tsx`; add a single tokens layer (CSS variables for colors, spacing, radius, the three font stacks). Keep prop contracts compatible with the Tauri event shapes below.
- Load the three substitute faces (Saira Condensed, Cormorant/EB Garamond, JetBrains/IBM Plex Mono) — self-host the woff2 locally (no Google Fonts CDN call at runtime; keep the Tauri bundle self-contained). If a face fails to load, the fallback stacks apply.
- Every dynamic surface ships a loading, empty, and error variant. No dead spinners, no blank panes. Empty states use a `display` headline (UPPERCASE, tracked) — they are brand surfaces, not afterthoughts.
- Accessibility basics: keyboard reachable, visible focus (the underline thickens to white on `text-input`; outline focus rings elsewhere), `aria-live` on the streaming reply and on bash output, dialog focus-trap, sufficient contrast on the pure-black theme. Note weight is **always 400** — never signal state with bold; use color-toward-white, tracking, or a hairline underline instead.
- Do **not** invent backend commands. Assume these exist and call/listen as shown:

```ts
// request/response (invoke)
get_config()                          // { pi_path, project_root, default_provider, default_model, default_thinking }
list_projects()                       // ProjectInfo[] { name, path, kinds[], mtime_ms, is_git }
send_prompt({ tabId, message })       // ack; reply streams via events
set_model({ tabId, model })
set_thinking_level({ tabId, level })
get_available_models()                // string[]
get_available_thinking_levels()       // string[]
approve({ requestId, allow })         // answers an ApprovalDialog
abort({ tabId })

// streamed events (listen)
"message_update"      { tabId, delta: { text?, thinking? } }
"toolcall_start"      { tabId, id, tool, summary }
"toolcall_delta"      { tabId, id, chunk }     // bash stdout/stderr, edit hunks, etc.
"toolcall_end"        { tabId, id }
"approval_request"    { tabId, requestId, tool, prompt, timeout? }
"agent_stopped"       { tabId, reason }
"drive_detached"      { tabId }
"drive_reconnected"   { tabId }
"toast"               { message }
```

### Out of scope (do not build)
Phase 2+ features: diff viewer UI, graphify graph status, kanban, pipeline stage-view, settings screen, cloud sync, multi-user, Windows/Linux, telemetry. Scaffold nothing for these — YAGNI.

### Brand Don'ts (non-negotiable)
- **No accent color** outside `{colors.link}` (`#c3d9f3`, inline links only). No brand-blue for active tabs, no green/red for Allow/Block, no colored spinner. Active = on-dark on `surface-card`.
- **No bold weight anywhere.** Everything is 400. Signal emphasis with size, tracking, case, or family — never weight.
- **No filled buttons.** `button-primary` is transparent + 1px white outline, pill. A solid-white CTA is off-brand.
- **No rounded corners except buttons.** Cards, photos, inputs, spec cells, dialogs = `{rounded.none}` `0px`.
- **No shadows, no gradients, no glassmorphism.** Depth = hairlines + `surface-card` tone on black.
- **Don't compress whitespace.** The `{spacing.section}` 120px rhythm is brand pacing, not wasted space.
- **Don't blur the typeface trinity.** Display = headlines (UPPERCASE, tracked). Text Regular (serif) = body prose incl. chat replies. Monospace = buttons, nav, captions, tool names, code. Never Display in a button, never Monospace in a paragraph, never Text Regular in a button.
- **Don't tighten display tracking.** 2–4px on headlines, 6px on the wordmark — non-negotiable.

---
