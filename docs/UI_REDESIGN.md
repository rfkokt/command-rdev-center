# UI Redesign — Quiet Native Workspace

## Status

Proposed design direction for the command-rdev-center interface.

This document replaces the obsolete root-level `DESIGN.md`. It defines the visual direction and implementation constraints for a clean, minimal interface with system-aware light and dark themes and progressive macOS Liquid Glass support.

## Goal

Make command-rdev-center feel like a focused native macOS workspace while preserving the information density required for coding agents, chat, terminal output, diffs, pipelines, Kanban, research, and project management.

The redesign should be:

- clean and minimal without becoming sparse;
- comfortable for long work sessions;
- consistent in light and dark appearances;
- familiar to macOS users;
- accessible when transparency or motion is reduced;
- usable on platforms and macOS versions without native glass effects.

## Design Direction

**Creative north star: Quiet Native Workspace.**

The application should use calm neutral surfaces, clear hierarchy, compact controls, and restrained color. Content is visually primary. Translucency communicates application structure and elevation rather than decorating every surface.

The existing “agent operations console” identity should not dictate the new interface. Agent activity remains visible through explicit status, motion, iconography, and semantic color, but the whole application should no longer look like a dark terminal dashboard.

### Principles

1. **Content first** — chat, code, terminal output, diffs, tables, and long-form text use stable, readable surfaces.
2. **Glass is chrome** — translucency belongs primarily to navigation, toolbars, floating controls, dialogs, popovers, and toasts.
3. **System appearance by default** — follow the operating system unless the user explicitly selects light or dark.
4. **Semantic tokens only** — components consume role-based tokens rather than hardcoded light or dark colors.
5. **Compact, not cramped** — preserve desktop information density with predictable spacing and hit targets.
6. **State is explicit** — never communicate running, success, warning, failure, or selection through color alone.
7. **Progressive enhancement** — the interface remains complete without blur or native Liquid Glass.

## Visual Foundation

### Typography

Use the native system font stack for application UI:

```css
font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
```

Use `JetBrains Mono` only for code, terminal output, diffs, commands, identifiers, and machine telemetry.

Recommended scale:

| Role | Size | Weight |
| --- | ---: | ---: |
| Workspace title | 18–20px | 600 |
| Panel title | 15–16px | 600 |
| Body/control | 13–14px | 400–500 |
| Secondary/meta | 11–12px | 400–500 |
| Code/telemetry | 11–13px | 400 |

Avoid broad uppercase labels and excessive letter spacing. Uppercase is reserved for genuinely short machine states where it improves scanning.

### Shape

- Standard control radius: `8px`.
- Compact controls: `6px`.
- Panels and dialogs: `10–12px`.
- Pills only for badges, segmented controls, or status chips.
- Do not round every nested container.

### Spacing

Use a compact 4px-based scale:

```text
4, 8, 12, 16, 20, 24, 32
```

Dense rows normally use 8–12px vertical rhythm. Dialogs and major content sections can use 20–24px padding.

### Color

Use neutral semantic tokens. The values below are starting points and should be tuned against screenshots and contrast checks.

```css
:root {
  color-scheme: light dark;

  --canvas: #f5f5f7;
  --surface: rgba(255, 255, 255, 0.72);
  --surface-solid: #ffffff;
  --surface-raised: rgba(255, 255, 255, 0.88);
  --surface-selected: rgba(0, 122, 255, 0.10);
  --text-primary: #1d1d1f;
  --text-secondary: #6e6e73;
  --separator: rgba(60, 60, 67, 0.16);
  --separator-strong: rgba(60, 60, 67, 0.28);
  --accent: #007aff;
  --success: #248a3d;
  --warning: #a05a00;
  --danger: #d70015;
  --info: #0071a4;
}

[data-theme="dark"] {
  --canvas: #111113;
  --surface: rgba(35, 35, 38, 0.72);
  --surface-solid: #1c1c1e;
  --surface-raised: rgba(48, 48, 52, 0.86);
  --surface-selected: rgba(10, 132, 255, 0.18);
  --text-primary: #f5f5f7;
  --text-secondary: #a1a1a6;
  --separator: rgba(235, 235, 245, 0.14);
  --separator-strong: rgba(235, 235, 245, 0.26);
  --accent: #0a84ff;
  --success: #30d158;
  --warning: #ff9f0a;
  --danger: #ff453a;
  --info: #64d2ff;
}
```

Runtime lime may remain as a narrowly scoped agent-running signal, but it must not be the general accent for navigation, buttons, links, focus, and every active state.

## Appearance Modes

Support three user choices:

- `system` — default; follows `prefers-color-scheme` and operating-system changes;
- `light`;
- `dark`.

Persist only the explicit preference. The resolved appearance should update without reloading when the system appearance changes.

Use `color-scheme` so native form controls, scrollbars, and browser-provided surfaces match the resolved theme.

## Liquid Glass Strategy

Liquid Glass is a material hierarchy, not a global blur effect.

### Appropriate surfaces

Use glass or vibrancy for:

- the primary sidebar;
- the top toolbar/titlebar region;
- a floating chat composer or compact floating action group;
- dialogs and sheets;
- popovers, menus, model pickers, and command menus;
- toasts and temporary overlays.

### Solid surfaces

Keep these solid or nearly opaque:

- chat messages and markdown prose;
- terminal panes;
- code blocks and syntax highlighting;
- diffs;
- Kanban cards;
- pipeline tables;
- settings forms with dense controls;
- research reports and knowledge documents.

### Webview fallback

```css
.glass-surface {
  background: var(--surface);
  border: 1px solid var(--separator);
  backdrop-filter: blur(24px) saturate(150%);
  -webkit-backdrop-filter: blur(24px) saturate(150%);
}

@media (prefers-reduced-transparency: reduce) {
  .glass-surface {
    background: var(--surface-solid);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}
```

The fallback must remain visually complete if `backdrop-filter` is unsupported. Avoid glass-on-glass nesting, large blurred content areas, and text placed directly over unpredictable backgrounds.

### Native macOS enhancement

Native macOS material is optional progressive enhancement, not a requirement for the base UI.

Before adding an AppKit or Tauri integration:

1. verify supported macOS versions;
2. avoid private APIs for production distribution;
3. detect capability at runtime;
4. preserve the CSS/solid fallback;
5. test titlebar dragging, window controls, fullscreen, multiple windows, and reduced transparency;
6. confirm that native material does not reduce text or terminal contrast.

Do not add a glass dependency until the app shell and semantic theme work correctly without it.

## Application Structure

```text
┌ translucent sidebar ┬ translucent toolbar ───────────┐
│ Projects             │ Project / session       Actions│
│ Sessions             ├─────────────────────────────────┤
│ Global               │                                 │
│ System               │          solid content          │
│                      │                                 │
└──────────────────────┴──── floating composer/glass ────┘
```

### Sidebar

- Use one calm navigation surface with subtle translucency.
- Keep projects, sessions, global views, and system views clearly grouped.
- Active rows use a tinted background plus text/icon state; avoid a loud full-width accent.
- Preserve truncation and accessible names for long project/session names.
- Keep resizing, but make the resize affordance visually subtle and keyboard-safe where practical.

### Toolbar

- Integrate visually with the macOS titlebar where window configuration permits.
- Show the current workspace and essential state only.
- Move secondary or rarely used actions into menus.
- Use one clear primary action at most.

### Workspace content

- Give each workspace one dominant content surface.
- Avoid nested cards used only for decoration.
- Use separators, spacing, headings, and background changes before adding shadows.
- Keep technical views dense and horizontally efficient.

### Chat

- Assistant responses remain content-first and largely unboxed.
- User messages may use a subtle raised/tinted surface.
- The composer can be the principal floating glass element.
- Tool calls, approvals, research, pipeline, and agent status share one semantic state vocabulary.

### Dialogs and popovers

- Use soft depth rather than hard offset shadows.
- Maintain strong boundaries in both themes.
- Preserve focus trapping, Escape behavior, initial focus, and focus restoration.
- Destructive actions use explicit labels and confirmation where data loss is possible.

## Interaction and Motion

- Hover changes color or elevation without shifting layout.
- Focus-visible uses a clear system-like ring with sufficient contrast.
- Motion should explain state changes, opening, closing, progress, or hierarchy.
- Typical transitions: 120–220ms.
- Avoid continuous glow, sweeping radar effects, decorative pulses, and large parallax.
- Agent-running animation must retain a static label/icon when motion is disabled.

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

## Accessibility Requirements

- Meet WCAG AA contrast for text and essential controls.
- Do not rely on translucency for separation.
- Do not rely on color alone for status.
- Maintain visible keyboard focus.
- Respect reduced motion and reduced transparency.
- Keep normal pointer targets near 36–44px where layout permits.
- Preserve semantic HTML, labels, accessible names, dialog behavior, and skip navigation.
- Test text and controls against both the intended blurred background and the solid fallback.

## Open-Source References

References provide patterns, not code or branding to copy.

### LinearMouse

<https://github.com/linearmouse/linearmouse>

Use as a reference for native macOS information hierarchy, compact settings, calm light/dark surfaces, and utility-app discipline.

### Stats

<https://github.com/exelban/stats>

Use as a reference for dense technical information, compact controls, restrained status colors, and scannable operational state.

### Tote

<https://github.com/ericmaro/tote>

Use as a Tauri + React + TypeScript desktop reference for sidebar/content composition and implementation constraints. Do not treat it as the sole visual template.

### Apple Liquid Glass

<https://developer.apple.com/videos/play/wwdc2025/219/>

Use as the primary conceptual reference for material hierarchy, adaptive appearance, controls, and content separation.

## Recommended Delivery Sequence

### Phase 1 — Theme foundation

- Introduce semantic color, type, spacing, radius, separator, and elevation tokens.
- Add `system`, `light`, and `dark` preferences.
- Remove hardcoded dark colors from shared component rules.
- Add reduced-transparency and reduced-motion fallbacks.
- Validate representative screens in both appearances.

### Phase 2 — Application chrome

- Redesign sidebar and toolbar.
- Align titlebar and window controls on macOS.
- Standardize navigation rows, buttons, inputs, menus, dialogs, and toasts.
- Apply restrained webview glass to eligible chrome.

### Phase 3 — Core workspaces

Migrate in this order:

1. Chat and composer.
2. Project/session navigation and activity rail.
3. Settings and pickers.
4. Kanban and pipeline.
5. Diff and terminal containers.
6. Deep Research, Knowledge, and Prompt Engines.

### Phase 4 — Native enhancement

- Evaluate a public and maintained native material integration.
- Add runtime capability detection and solid fallback.
- Test supported macOS versions and accessibility preferences.
- Ship only if native material is measurably better than the CSS implementation.

## Validation Checklist

Each migrated surface must be checked for:

- light, dark, and live system-theme switching;
- reduced transparency;
- reduced motion;
- keyboard-only navigation;
- visible focus and correct dialog focus restoration;
- long names, long messages, empty states, loading, errors, and disabled controls;
- narrow windows and resized sidebar;
- readable terminal, diff, markdown, and syntax-highlighted content;
- no unintended transparent or low-contrast layers;
- macOS titlebar dragging, fullscreen, and window controls where applicable.

Use screenshots of representative screens in light and dark before considering a phase complete.

## Non-Goals

- Rewriting the React application architecture.
- Replacing all components with a UI framework.
- Applying glass to every card or content surface.
- Copying another product’s layout or brand.
- Depending on private macOS APIs.
- Sacrificing information density to imitate a marketing website.
- Adding decorative gradients, neon effects, or constant animation.

## AI Agent Execution Inventory

This section is the authoritative migration inventory. An implementation agent should work through it instead of rediscovering UI scope file by file.

### Working rules for agents

1. Preserve application behavior unless a checklist item explicitly requires interaction changes.
2. Start with tokens and shared primitives; do not independently restyle every feature first.
3. Replace hardcoded colors with semantic tokens while touching a rule. Do not merely add light-mode overrides over dark-only values.
4. Keep glass limited to chrome and temporary elevated surfaces.
5. Reuse current components and accessibility hooks. Do not introduce a UI framework or speculative design-system abstraction.
6. Validate each migration batch in light, dark, system, reduced motion, and reduced transparency.
7. Update or add the smallest behavior test needed when markup, keyboard behavior, persistence, or modal behavior changes. Visual CSS-only changes should be screenshot-validated rather than snapshot-tested.
8. Run `pnpm test` and `pnpm build` after each implementation batch.

### Scope summary from repository analysis

The current UI is composed of:

- 4 application stylesheets containing roughly 923 lines;
- approximately 392 hardcoded color/effect occurrences, primarily in `src/App.css`;
- 24 user-facing TSX components;
- 9 TSX files with inline styles that may bypass theme tokens;
- shared modal focus behavior used across dialogs and pickers;
- Tauri window configuration that may affect native titlebar and material integration.

The migration is primarily CSS and component markup work. Backend Rust modules and frontend data libraries do not need visual changes unless native window appearance or persisted theme storage requires a command/config change.

## File-by-File Redesign Checklist

Legend:

- **P0** — foundation or shared dependency; migrate first.
- **P1** — primary application shell and daily workflow.
- **P2** — secondary workspace or settings surface.
- **P3** — validation/supporting file; change only as required.
- **Review only** — verify compatibility; no expected redesign code.

### Foundation and application shell

#### `src/App.css` — P0

Current role: global reset, theme variables, application shell, sidebar, toolbar, shared controls, dialogs, Kanban, pipeline, chat, terminal, diff, picker, and several feature-specific rules.

Required work:

- Replace the current dark-only root palette with semantic light/dark tokens.
- Define canvas, solid/translucent surfaces, primary/secondary text, separators, accent, semantic states, focus, shadow, radius, spacing, and material tokens.
- Remove hardcoded lime coupling from generic links, focus, selection, buttons, and navigation.
- Keep runtime lime only if retained as an agent-running semantic signal.
- Convert hardcoded backgrounds, borders, shadows, code colors, status colors, and overlay colors.
- Add `color-scheme`, system-theme behavior, reduced-transparency fallback, and consistent reduced-motion handling.
- Replace hard offset shadows with soft, restrained elevation.
- Consolidate duplicated button/input/dialog/list-picker rules where this reduces overrides without creating a new component framework.
- Verify terminal, diff, code, and markdown surfaces remain sufficiently opaque.

#### `src/application-redesign.css` — P0

Current role: later-stage overrides for the app shell and multiple redesigned feature surfaces.

Required work:

- Audit every selector against `App.css` and remove stale override chains.
- Move canonical shared tokens/rules into one owner stylesheet.
- Retain this file only for coherent feature-level styles; delete it if its rules can be folded into existing owners without increasing complexity.
- Convert all remaining hardcoded colors and translucent backgrounds to semantic tokens.
- Ensure light mode is designed directly, not produced by filter/inversion tricks.

#### `src/core-workspace.css` — P0

Current role: core chat/workspace layout and responsive behavior.

Required work:

- Preserve workspace density and scrolling boundaries.
- Align chat header, content column, composer, rails, and responsive states with the new shell.
- Make the composer the primary eligible glass/floating surface.
- Keep messages, tool output, code, and terminal content solid.
- Verify narrow-window behavior after sidebar/titlebar changes.

#### `src/prompt-engines.css` — P2

Current role: Prompt Engines library, form, editor, empty state, and run history.

Required work:

- Replace feature-local colors with semantic tokens.
- Align forms, list selection, editor, action hierarchy, and empty states with shared components.
- Preserve high-density editing and avoid nested decorative cards.

#### `src/App.tsx` — P0/P1

Current role: app shell, sidebar, toolbar, global/project navigation, workspace routing, update action, settings host, toast host, and session tabs.

Required work:

- Add the resolved appearance state and `system | light | dark` preference plumbing, preferably using browser APIs and local storage unless native persistence is demonstrably needed.
- Apply a stable `data-theme` or equivalent resolved-theme attribute at the document root.
- Subscribe to system appearance changes only while preference is `system`.
- Redesign sidebar and toolbar markup only where semantic grouping or native titlebar integration requires it.
- Replace inline presentation styles for sidebar resizing, unread badges, and toast positioning with classes/tokens where they block theming.
- Preserve skip navigation, landmarks, session persistence, resizing, lazy views, update behavior, and existing callbacks.
- Ensure draggable titlebar regions never cover interactive controls if native titlebar integration is introduced.

#### `src/main.tsx` — P3

Current role: React entry point.

Required work:

- If needed, initialize theme before first render to prevent a light/dark flash.
- Do not add app architecture or state management solely for theming.

#### `index.html` — P3

Required work:

- Add only the minimum pre-render appearance bootstrap or background metadata needed to avoid theme flash.
- Verify the initial document background matches both appearances.

#### `src-tauri/tauri.conf.json` — P2/native phase

Current role: Tauri window and build configuration.

Required work:

- Review titlebar style, transparency, decorations, traffic-light positioning, shadows, and platform-specific window options before native material work.
- Preserve non-macOS behavior.
- Do not enable transparent windows until contrast, dragging, resizing, fullscreen, and fallback behavior are validated.

#### `package.json` — review only unless cleanup/native work requires it

Required work:

- Do not add a UI library for this redesign.
- Audit unused `@fontsource/*` packages after the native-font migration and remove only packages with no imports/usages.
- Add a native glass/vibrancy dependency only during Phase 4 and only after public API and fallback review.

### Shared controls, overlays, and content renderers

#### `src/components/ListPicker.tsx` — P0

Surface: reusable select trigger and popover menu used by Kanban/settings.

Required work:

- Standardize trigger height, selection, hover, focus, separators, menu radius, and soft elevation.
- Use glass only for the popover; the field remains a normal control surface.
- Preserve listbox semantics and keyboard behavior.

#### `src/components/ModelPicker.tsx` — P0/P1

Surface: model search dialog and selectable model list.

Required work:

- Align with the shared dialog, search field, list row, selected state, and glass overlay vocabulary.
- Remove duplicated picker styling where `ListPicker`/shared dialog rules already cover it.
- Preserve focus management and listbox semantics.

#### `src/components/FilePicker.tsx` — P1

Surface: file search/results overlay used by chat.

Required work:

- Replace inline colors, box shadow, positioning values, and active-row styling with semantic classes.
- Align search, result rows, metadata, loading, empty, and keyboard-active states.
- Treat the overlay as eligible glass but keep previews/results readable.

#### `src/components/ApprovalDialog.tsx` — P0/P1

Surface: agent/tool approval prompt, options, custom input, submit/cancel actions.

Required work:

- Make risk and primary action hierarchy explicit without a lime top stripe.
- Align dialog material, typography, option rows, input, focus, and destructive variants.
- Preserve trust-boundary copy, button labels, keyboard interaction, and focus behavior.

#### `src/components/ConfirmDialog.tsx` — P0

Surface: generic confirm/destructive confirmation host.

Required work:

- Share the same dialog vocabulary as `ApprovalDialog` without merging their behavior unnecessarily.
- Ensure destructive state uses icon/text in addition to color.
- Preserve promise settlement and modal focus behavior.

#### `src/components/useModalFocus.ts` — review only/P0 validation

Current role: shared modal focus stack, Escape handling, focus trap/restoration.

Required work:

- Reuse unchanged where possible.
- Verify every redesigned dialog/picker continues to call it correctly.
- Change only if titlebar/glass markup exposes a real focus bug.

#### `src/components/MarkdownMessage.tsx` — P1

Surface: assistant/research markdown, tables, code blocks, Mermaid, large-message disclosure.

Required work:

- Keep prose content-first with a readable line length and no glass behind text.
- Theme headings, links, quotes, tables, inline code, code containers, Mermaid containers, and disclosure controls.
- Ensure syntax and KaTeX remain legible in both appearances.
- Preserve sanitization and streaming behavior.

#### `src/components/SyntaxCodeBlock.tsx` — P1

Surface: syntax-highlighted code blocks.

Required work:

- Provide explicit light and dark syntax themes or semantic token mapping.
- Avoid transparent code backgrounds over glass.
- Check selection, copy, long lines, and contrast.

#### `src/components/ThinkingBlock.tsx` — P1

Surface: collapsible agent thinking/reasoning display.

Required work:

- Restyle as quiet secondary disclosure rather than a high-emphasis card.
- Preserve clear expanded/collapsed state and readable technical content.

#### `src/components/ToolCall.tsx` — P1

Surface: generic tool call, JSON tree, web-search progress/results, subagent status.

Required work:

- Define one semantic vocabulary for queued/running/success/failure/cancelled states.
- Theme JSON tokens for both appearances.
- Reduce decorative glow/pulse while preserving visible live state.
- Replace inline presentation styles where they prevent token use.
- Preserve distinctions among web search, subagent activity, generic tools, and errors.

### Navigation and project surfaces

#### `src/components/ProjectList.tsx` — P1

Surface: projects, sessions, unread/running state, project settings, branch picker, source settings, and project removal dialogs.

Required work:

- Redesign project/session hierarchy, disclosure rows, active state, hover, metadata, badges, and settings controls.
- Replace inline unread/state colors with semantic classes.
- Align branch/settings/remove dialogs with shared dialog vocabulary.
- Preserve long-name truncation, titles, disclosure animation, scrolling, and destructive confirmation.

#### `src/components/ProjectFilesSidebar.tsx` — P1

Surface: code/file rail, filter, flat/tree lists, recent files, preview dialog, image/markdown/code preview.

Required work:

- Align rail and toolbar with the app chrome while avoiding nested glass.
- Theme active rows, folder/file icons, metadata, filter, errors, loading, and empty states.
- Make preview dialog share dialog/elevation tokens.
- Theme code gutter/content and markdown preview for both appearances.
- Replace inline preview/highlight styles where they bypass tokens.

### Primary workspace

#### `src/components/ChatView.tsx` — P1, largest migration

Surface: chat mode controls, session header, agent activity, messages, composer, attachments, slash menu, code rail, usage dialog, image lightbox, diff host, dev controls, graph progress, and research integration.

Required work:

- Break implementation into visual batches; do not rewrite chat state/event logic.
- Header/mode controls: align segmented selection, project metadata, dev controls, and status chips.
- Messages: keep assistant content largely unboxed; use a subtle surface for user messages; normalize metadata/actions.
- Composer: create one floating glass surface with solid input affordance, attachment state, queue state, send/abort hierarchy, and clear focus.
- Agent state: unify working, follow-up, pipeline, graph, subagent, tool, and error status vocabulary.
- Menus/overlays: align slash menu, usage dialog, model picker, image preview, and lightbox.
- Code/activity rails: match navigation hierarchy and ensure selected states work in light/dark.
- Remove presentation-heavy inline styles that prevent tokenization.
- Preserve streaming, inactive session memory bounds, keyboard submission, file picking, resuming, research, pipeline, terminal, diff, and notification behavior.

#### `src/components/TerminalPanel.tsx` — P1

Surface: floating/resizable terminal, pane splits, titlebar, controls, embedded Ghostty terminal.

Required work:

- Keep terminal content opaque and independent of surrounding glass.
- Align terminal frame/titlebar/actions with shared elevation and control tokens.
- Replace inline geometry/color presentation where it blocks theming; preserve runtime drag/resize dimensions.
- Verify multiple panes, splits, focus, close/kill controls, and contrast.

#### `src/components/DiffPanel.tsx` — P1

Surface: diff dialog, file summaries, split diff, handoff/ship action.

Required work:

- Keep diff content solid.
- Define accessible light/dark added/removed/empty line colors.
- Align dialog header, summaries, actions, separators, and scrolling.
- Preserve sticky regions and wide-diff behavior.

### Feature workspaces

#### `src/components/KanbanBoard.tsx` — P2

Surface: board header, filters, status columns/cards, task detail dialog, source errors.

Required work:

- Use neutral columns with restrained semantic status accents rather than tinted full surfaces.
- Theme cards, counts, filters, empty/error/loading states, readonly status, and detail dialog.
- Preserve horizontal density, sticky/scroll behavior, status readability, and task actions.

#### `src/components/PipelineView.tsx` — P2

Surface: project pipeline table, stage status, actions, Sonar progress, pending-input prompt.

Required work:

- Theme table, sticky headers/columns, stages, prompt, and action hierarchy.
- Replace radar/glow-heavy progress with a quieter but explicit running indicator.
- Preserve pass/fail/running/pending/skip labels in addition to color.

#### `src/components/DeepResearchView.tsx` — P2

Surface: run list, report reader, table of contents, progress/error/warning states, composer, sources, cancel dialog.

Required work:

- Prioritize long-form reading with a solid paper/content surface in both themes.
- Keep list/TOC as secondary navigation; glass only if it belongs to app chrome.
- Align composer, progress, sources, warnings, and cancel dialog.
- Preserve embedded mode and all run actions.

#### `src/components/RagKnowledge.tsx` — P2

Surface: knowledge source table, upload/drop state, progress toast, preview panel.

Required work:

- Align table, upload action, drop target, source status, empty/error states, and preview dialog.
- Replace inline toast/presentation styles with semantic classes.
- Keep document preview solid and readable.

#### `src/components/PromptEnginesView.tsx` — P2

Surface: engine library, editor/form, model trigger, instructions editor, actions, run history, empty states.

Required work:

- Align library selection with sidebar/list rows and editor fields with shared forms.
- Clarify primary save/run actions versus secondary import/delete actions.
- Remove decorative card nesting and preserve dense editing.

### Settings surfaces

#### `src/components/SettingsPanel.tsx` — P2

Surface: modal settings shell, category navigation, scope selector, form/JSON mode, shared settings controls.

Required work:

- Establish the canonical settings layout and shared form style used by child settings pages.
- Theme settings backdrop/panel, category selection, scope selection, mode control, inputs, toggles, notices, errors, loading, and save action.
- Use glass for the settings shell only if content sections remain solid/readable.
- Preserve focus, close behavior, project/global scope, and JSON editing.

#### `src/components/GraphifySettings.tsx` — P2

Surface: Graphify model/settings form and model picker.

Required work:

- Reuse canonical settings fields, notices, search, list rows, loading, success/error, and save action.
- Avoid a separate visual vocabulary for its model picker.

#### `src/components/McpSettings.tsx` — P2

Surface: MCP settings and toggles.

Required work:

- Reuse canonical settings sections, toggles, notices, errors, and save actions.
- Preserve status clarity without color-only indicators.

#### `src/components/RagSettings.tsx` — P2

Surface: RAG configuration and toggles.

Required work:

- Reuse canonical settings sections and remove inline presentation values.
- Align explanatory copy, toggle states, errors, and save action.

#### `src/components/PipelineSettings.tsx` — P2, complex settings migration

Surface: pipeline target, preset actions, ordered steps, command/policy fields, AI consultant drawer/chat/draft.

Required work:

- Align all fields, select controls, toggles, step rows, add/remove actions, guides, and errors.
- Make step ordering and disabled states clear without full-surface status tint.
- Treat consultant drawer as an elevated temporary surface; keep its chat/draft readable and solid.
- Preserve configuration semantics, optional-step rules, and save behavior.

## Inline Style Cleanup Targets

The following files currently contain inline styles and require explicit review because values may bypass themes:

- `src/App.tsx` — sidebar resize handle, sidebar width, unread badge, toast container.
- `src/components/ChatView.tsx` — dynamic rail/layout geometry and several presentation values.
- `src/components/FilePicker.tsx` — overlay/result presentation.
- `src/components/ProjectFilesSidebar.tsx` — preview/highlight presentation.
- `src/components/ProjectList.tsx` — badges and project/session presentation.
- `src/components/RagKnowledge.tsx` — progress/preview presentation.
- `src/components/RagSettings.tsx` — form presentation.
- `src/components/TerminalPanel.tsx` — movable/resizable geometry plus visual values.
- `src/components/ToolCall.tsx` — JSON/activity presentation.

Keep genuinely dynamic geometry inline when CSS custom properties or classes would be less clear. Move static color, border, background, spacing, radius, and shadow values to CSS tokens.

## Tests and Validation Files

### Existing tests to preserve/update — P3

- `src/App.test.tsx` — extend for persisted appearance and system-theme resolution if theme logic lives in `App`.
- `src/components/useModalFocus.test.tsx` — must continue passing for every modal migration.
- `src/components/ConfirmDialog.test.tsx` — update only for intentional dialog interaction/markup changes.
- `src/components/ChatResearchAccess.test.tsx` — preserve chat/research access behavior.
- `src/components/ChatView.test.ts` — preserve chat utility/state behavior; no visual snapshots required.
- `src/components/ToolCall.test.ts` — preserve activity classification and add semantic state checks only if behavior changes.
- `src/components/MarkdownMessage.test.ts` — preserve formatting, sanitization, and code behavior.
- `src/components/ProjectFilesSidebar.test.ts` — preserve preview classification.
- `src/components/DeepResearchView.test.tsx` — preserve run actions, rendering, and embedded behavior.
- `src/components/KanbanBoard.test.tsx` — preserve board/task interactions.
- `src/components/PipelineView.test.tsx` — preserve stage/pending-input actions.
- `src/components/PipelineSettings.test.tsx` — preserve configuration editing and policy behavior.

### No expected visual changes

These files contain data/view-model logic and should normally remain unchanged:

- `src/components/chat-utils.ts`;
- `src/lib/rpc.ts`;
- `src/lib/deep-research.ts` and its tests;
- `src/lib/prompt-engines.ts` and its tests;
- `src/vite-env.d.ts`;
- backend Rust modules, except an intentional native window/theme integration.

## Migration Batches and Exit Criteria

### Batch A — Semantic foundation

Files:

- `src/App.css`;
- `src/application-redesign.css`;
- `src/core-workspace.css`;
- `src/App.tsx`;
- optionally `src/main.tsx` and `index.html` for flash prevention.

Exit criteria:

- `system | light | dark` resolves and persists correctly;
- no initial theme flash in normal startup;
- shell renders readable in both themes;
- reduced transparency produces solid surfaces;
- existing tests and build pass.

### Batch B — Shared primitives

Files:

- `ListPicker.tsx`;
- `ModelPicker.tsx`;
- `FilePicker.tsx`;
- `ApprovalDialog.tsx`;
- `ConfirmDialog.tsx`;
- `MarkdownMessage.tsx`;
- `SyntaxCodeBlock.tsx`;
- `ThinkingBlock.tsx`;
- `ToolCall.tsx`.

Exit criteria:

- shared controls and overlays have one coherent visual vocabulary;
- modal keyboard/focus tests pass;
- syntax, JSON, markdown, Mermaid, and KaTeX are readable in both themes.

### Batch C — Shell navigation and chat

Files:

- `ProjectList.tsx`;
- `ProjectFilesSidebar.tsx`;
- `ChatView.tsx`;
- `TerminalPanel.tsx`;
- `DiffPanel.tsx`.

Exit criteria:

- main daily workflow is visually complete;
- composer is the principal glass surface;
- code, terminal, diff, and messages remain solid/readable;
- sidebar resizing, rails, overlays, streaming, and keyboard submission still work.

### Batch D — Secondary workspaces

Files:

- `KanbanBoard.tsx`;
- `PipelineView.tsx`;
- `DeepResearchView.tsx`;
- `RagKnowledge.tsx`;
- `PromptEnginesView.tsx`;
- `src/prompt-engines.css`.

Exit criteria:

- each workspace uses semantic states and shared controls;
- dense tables/boards and long-form reading remain usable;
- no dark-only or decorative-glass islands remain.

### Batch E — Settings

Files:

- `SettingsPanel.tsx`;
- `GraphifySettings.tsx`;
- `McpSettings.tsx`;
- `RagSettings.tsx`;
- `PipelineSettings.tsx`.

Exit criteria:

- all settings pages share form, toggle, notice, picker, and action styling;
- global/project scope and complex pipeline editing remain clear;
- no settings page defines an independent color system.

### Batch F — Native macOS enhancement and cleanup

Files as needed:

- `src-tauri/tauri.conf.json`;
- Tauri Rust/window setup only if required;
- `package.json` and lockfile only for a justified public dependency;
- stylesheet cleanup and unused font removal.

Exit criteria:

- native material is capability-gated and optional;
- non-macOS and unsupported macOS versions retain the complete solid/CSS fallback;
- window dragging, traffic lights, resize, fullscreen, focus, and accessibility preferences work;
- unused styles, overrides, font imports, and dependencies are removed.

## Final Agent Definition of Done

The redesign is complete only when:

1. every user-facing component listed above has been reviewed and either migrated or explicitly documented as requiring no change;
2. hardcoded visual colors in active component rules are replaced by semantic tokens, except deliberate syntax/data-visualization values with verified light/dark variants;
3. light, dark, and live system switching work without reload;
4. reduced transparency and reduced motion produce complete, readable interfaces;
5. glass appears only on approved chrome/elevated surfaces;
6. keyboard navigation, modal focus, resizing, scrolling, streaming, and destructive confirmations remain functional;
7. representative screenshots exist for app shell, chat, settings, Kanban/pipeline, and research in light and dark;
8. `pnpm test` and `pnpm build` pass;
9. no private macOS API or unnecessary UI dependency has been introduced;
10. obsolete CSS, font packages, and override layers discovered during migration are removed rather than retained “for later.”

## Decision Summary

The redesign will use a native, neutral, content-first foundation. Semantic themes are mandatory; Liquid Glass is progressive enhancement for application chrome. LinearMouse informs native hierarchy, Stats informs technical density, Tote informs Tauri/React constraints, and Apple guidance governs material behavior. The existing React structure can remain; implementation should begin with shared tokens and the app shell rather than a component rewrite.
