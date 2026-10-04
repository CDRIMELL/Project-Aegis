# 0002 — TypeScript simulation core in a Web Worker

- Status: Accepted
- Date: 2026-10-04

## Context

The handover requires a simulation engine "independent from the UI" but does not say where it runs.
The two candidates were a Rust engine in the Tauri core process and a TypeScript engine in the
webview.

## Decision

The engine is TypeScript. `@aegis/domain` (pure rules and value types) and `@aegis/sim` (clock,
engine, runner) have no dependency on React, the DOM, Tauri or the database driver. In the desktop
app the engine runs inside a dedicated Web Worker; the UI thread only sends commands and receives
state views.

Tauri's IPC bridge is not available inside a Web Worker. The worker therefore reaches the database
through a small request/response relay on the UI thread (see ADR 0003). The relay forwards SQL
statements and nothing else.

## Alternatives considered

- **Rust engine.** Immune to webview timer throttling and closer to the database, but all domain
  logic would live in a second language, Drizzle would become redundant, and iteration would be
  slower for a single developer. Rejected.
- **Engine on the UI thread.** Simplest, but long accelerated steps would block rendering. Rejected.

## Consequences

- One language for domain, simulation, persistence mapping and UI; types are shared directly.
- The whole engine, including persistence, runs under Vitest in Node without launching Tauri.
- The webview may throttle timers when the window is minimised. The runner advances by measured
  elapsed time with a catch-up cap, so throttling slows the world but cannot corrupt it.
- The worker protocol is an explicit, versionable contract (`@aegis/sim` `protocol.ts`).
