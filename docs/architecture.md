# AEGIS architecture

This document describes how AEGIS is built as of milestone 1 (foundation). It is the map; the
[ADRs](adr/README.md) are the reasons. Product intent lives in the master handover specification.

## What exists today

A desktop application whose simulated world consists of a clock, a seeded random source and an
integrity digest. That is deliberately little. What matters is that the full path is real:

```
user command -> worker -> engine step -> checkpoint -> SQL batch -> Rust -> SQLite -> restart -> same world
```

Every later feature (flight, missions, weather, events) adds state and rules to this path. None of
them should need to change its shape.

## Runtime layout

```
+----------------------- WebView2 -----------------------+      +----------- Rust core -----------+
|                                                        |      |                                 |
|  UI thread                     Simulation worker       |      |  SessionGate                    |
|  React + @aegis/ui             @aegis/sim runner       |      |  statement guard                |
|  Zustand (latest view)         @aegis/domain rules     |      |  one rusqlite connection        |
|  SimClient  <--- views -----   @aegis/db world store   |      |  migrations (embedded)          |
|      |      ---- commands -->        |                 |      |                                 |
|      |      <--- sql:request ---     |                 |      |                                 |
|      |      ---- sql:result ---->                      |      |                                 |
|      +------------------ invoke db_query / db_batch ---------->  SQLite file (WAL)              |
+--------------------------------------------------------+      +---------------------------------+
```

- **Simulation worker.** Owns the world while the app runs. A 100 ms timer calls
  `SimulationRunner.advance()`, which converts elapsed real time into whole simulation steps.
- **UI thread.** Renders the latest `SimView` and sends commands. It also relays the worker's SQL to
  the native core, because Tauri's IPC is not available inside a worker. The relay forwards
  messages unchanged.
- **Rust core.** Owns the only SQLite connection. It knows nothing about the simulation; it applies
  migrations, enforces the session gate and executes statements.

## Packages

| Package         | Responsibility                                                              | May depend on        |
| --------------- | --------------------------------------------------------------------------- | -------------------- |
| `@aegis/domain` | Value types and pure rules: simulation time, speed multipliers, RNG, digest | nothing              |
| `@aegis/sim`    | Engine, runner, world snapshot, persistence port (`WorldStore`)             | `domain`             |
| `@aegis/db`     | Drizzle schema, migrations, SQL transport, `SqliteWorldStore`               | `domain`, `sim`      |
| `@aegis/ui`     | Design tokens and every shared component                                    | React, Radix, Lucide |
| `apps/desktop`  | Tauri shell, worker host, IPC bridge, screens                               | all of the above     |

`domain` and `sim` compile without DOM or Node typings, and ESLint forbids them from importing UI,
platform or persistence code and from using `Date.now`, `Math.random` or timers. A violation fails
`npm run lint` or `npm run typecheck`.

## Simulation model

- **Fixed step.** One step is one simulated second (`SIM_STEP_MS`). Simulation time is always
  `epoch + tick * 1000 ms`; it is derived, never accumulated.
- **Speed.** 1, 2, 5, 10, 50 or 100 simulated seconds per real second. Speed changes how many steps
  run per real second and nothing else. Pause is a run state, not a speed.
- **Engine** (`SimulationEngine`). Holds world state and advances it with `runSteps(n)`. It has no
  access to clocks or global randomness.
- **Runner** (`SimulationRunner`). Turns real elapsed time into steps, applies commands and decides
  when to checkpoint. Real time is injected through a `HostClock`, so tests drive it by hand.
- **Catch-up cap.** One `advance` honours at most one real second of elapsed time. If the host
  stalls or the webview throttles timers, the world slows down; it does not burst.
- **Randomness.** `xoshiro128**`, one named stream per subsystem, all derived from the world seed.
  Stream states are part of the world and are checkpointed.
- **Integrity digest.** Each step folds the tick number and one random draw into a rolling digest.
  Equal digests at equal ticks mean two runs executed identically. It is how tests, and the System
  screen, prove a world continued exactly across a restart.

Adding a subsystem means: add its state to `WorldSnapshot`, call it from `SimulationEngine.step()` in
a fixed position, give it its own RNG stream, persist its state in the same checkpoint batch, and
bump `SIM_MODEL_VERSION` if existing worlds would behave differently.

## Persistence model

- **Checkpoint.** One transaction writes the clock, every RNG stream, the digest and the checkpoint
  sequence number. The database always describes a single simulation instant.
- **When.** Every 2 s of real time while the world is changing; immediately on pause, resume and
  speed change; and when the window closes.
- **Ordering.** Writes never overlap. If one is in flight, the newest capture waits and replaces any
  older capture still waiting.
- **Failure.** A failed write is reported in the view, the world keeps running, and the next
  interval retries.
- **Restart.** `SimulationRunner.open` loads the checkpoint, validates it (Zod at the storage
  boundary, then engine invariants) and resumes. No simulated time passes while the app is closed.
- **Crash.** At most one checkpoint interval of progress is lost. What remains is consistent.

### Schema

| Table            | Rows | Contents                                           |
| ---------------- | ---- | -------------------------------------------------- |
| `sim_world`      | 1    | seed, simulation model version, epoch              |
| `sim_clock`      | 1    | simulation time, tick, speed, running              |
| `sim_checkpoint` | 1    | sequence number, wall-clock time, integrity digest |
| `sim_rng_stream` | n    | one row per named RNG stream                       |

Singleton tables enforce `id = 1` with a CHECK constraint. Table prefixes separate families:
`ref_` (sourced reference data), `sim_` (simulated world), `sys_` (application records).

### Changing the schema

1. Edit `packages/db/src/schema.ts`.
2. `npm run db:generate -- --name <what_changed>` writes a SQL migration.
3. Commit the migration. Never edit a migration that has been applied anywhere: both runners
   compare checksums and refuse to start.

At startup the Rust core applies pending migrations, each in its own transaction, after taking a
`VACUUM INTO` backup if the database already holds data.

## Native core command surface

| Command    | Purpose                                            | Gated |
| ---------- | -------------------------------------------------- | ----- |
| `db_query` | Run one data statement                             | yes   |
| `db_batch` | Run statements in one all-or-nothing transaction   | yes   |
| `app_info` | Version, database path, SQLite version, gate state | no    |

Only `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `REPLACE` and `WITH` statements are accepted over IPC.

## Security posture today

In place: session gate on every data command, statement allowlist, minimal Tauri capabilities,
strict Content Security Policy, typed errors, validation of data read from disk, an encryption seam
in `OpenOptions`.

Not in place until phase 9: authentication, MFA, auto-lock, security audit trail, encryption at
rest. The gate currently opens at startup. See [ADR 0010](adr/0010-security-hooks.md).

## User interface

All visual decisions live in `@aegis/ui` (see [design-system.md](design-system.md)). Screens compose
its components and may add layout utilities only.

The UI store holds the latest `SimView` for React. It is a mirror: nothing in it is written back
into the simulation. High-frequency per-entity state (aircraft positions) will bypass React and feed
the map directly when the map arrives.

## Testing

| Layer       | Tool                   | What it proves                                                               |
| ----------- | ---------------------- | ---------------------------------------------------------------------------- |
| Domain      | Vitest, fast-check     | RNG reference vector, stream isolation, bounds, time and digest helpers      |
| Simulation  | Vitest                 | Determinism, every speed, pause/resume, catch-up cap, checkpoint policy      |
| Persistence | Vitest + `node:sqlite` | Round trip, atomic rollback, constraints, restart continuity, crash recovery |
| Native core | `cargo test`           | Batch atomicity, statement guard, value conversion, migrations, backup, gate |

Persistence tests use the same Drizzle driver and SQL as production; only the transport differs.

## Commands

| Command               | Does                                                        |
| --------------------- | ----------------------------------------------------------- |
| `npm run dev`         | Run the desktop app with hot reload                         |
| `npm run build`       | Build the release executable and installer                  |
| `npm run check`       | Format check, lint, type-check, TypeScript tests            |
| `npm run check:rust`  | `cargo fmt --check`, `clippy -D warnings`, `cargo test`     |
| `npm run ci`          | Both of the above; the single entry point for any CI system |
| `npm run db:generate` | Generate a migration from schema changes                    |
