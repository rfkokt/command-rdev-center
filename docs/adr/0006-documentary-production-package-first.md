---
title: Documentary production package before renderer
status: accepted
date: 2026-08-10
---

# Documentary production package before renderer

## Decision

Phase 1 produces a durable, human-editable production package: approved research snapshots, cited script claims, 5–8 vertical-reel scenes, and a manual asset checklist. It exports `research.md`, `sources.json`, `script.md`, `scenes.json`, and `asset-checklist.md`.

The package is planning data, not a fact-checking guarantee. Users approve sources, retain ownership of asset licensing, and review every generated claim and visual recommendation before use.

No Remotion dependency, renderer, preview, asset importer, copied media, or timeline editor belongs in Phase 1.

## Consequences

- Package snapshots survive independently of Pi transcripts.
- Verified claims retain approved source IDs; unsourced interpretation remains explicitly `uncertain`.
- Exports use portable package-owned filenames and contain no source bodies or media.
- A later renderer consumes the schema only after real package use validates it.

## Phase 2 entry criteria

Start fixed rendering only after at least three packages complete end-to-end, users can fill the checklist without raw JSON, one user manually builds a reel from an export and identifies missing fields, and the schema stabilizes across those packages.
