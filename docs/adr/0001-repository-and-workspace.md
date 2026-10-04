# 0001 — Repository outside OneDrive; npm workspaces with hard boundaries

- Status: Accepted
- Date: 2026-10-04

## Context

The handover workspace (`Desktop\Project AEGIS`) lives inside OneDrive. `node_modules` and Rust's
`target/` hold several gigabytes across hundreds of thousands of files; syncing them causes file-lock
build failures and slow builds.

The handover also requires that simulation rules never depend on React. A convention alone does not
enforce that.

## Decision

- The Git repository lives at `C:\dev\aegis`. The OneDrive folder holds only the specification.
- The repository is an npm workspace (npm ships with Node; no extra tool to install).
- Code is split into packages whose dependency direction is fixed:

  ```
  domain  <-  sim  <-  db
                  \      \
  ui  <-----------  apps/desktop
  ```

  - `@aegis/domain` and `@aegis/sim` compile without the DOM library and may not import React,
    Tauri, Drizzle or any Node API. ESLint also bans `Date.now`, `Math.random` and timers there.
  - `@aegis/db` implements persistence ports that `@aegis/sim` declares.
  - `@aegis/ui` owns every design token and shared component.

- Packages are consumed as TypeScript source (`exports` points at `src/index.ts`). There is no
  per-package build step; Vite and Vitest compile them.

## Consequences

- A forbidden import in the domain or simulation is a type-check or lint failure, not a review comment.
- New packages are added only when a real boundary appears (`@aegis/ingest` arrives with phase 2).
- Source-consumed packages cannot be published as-is. That is acceptable: none are meant to be.
