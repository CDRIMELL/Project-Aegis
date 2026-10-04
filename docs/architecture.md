# AEGIS architecture

This document describes how AEGIS is built as of phase 5. It is the map; the
[ADRs](adr/README.md) are the reasons. Product intent lives in the master handover specification.

## What exists today

Three things:

- **A simulated world**: a clock, seeded random streams, an integrity digest, a fleet of aircraft
  that fly planned routes between real aerodromes, missions that give those flights a purpose,
  opportunities the world generates, and an append-only log of everything that happened, all
  persisted and restored exactly.
- **Real reference data** (countries, aerodromes, runways, cities, aircraft types) with provenance,
  shipped inside the application and installed on first launch. See
  [reference-data.md](reference-data.md).
- **The application shell and the world map**, which draws that reference data over an offline
  basemap and is ready to draw simulated entities above it.

The three table families keep these apart: `ref_*` is the real world, `sim_*` is the fictional
AEGIS world, `sys_*` is the application itself. Nothing simulated is written to `ref_*`, and no
reference record becomes a simulated entity automatically.

The simulated world is deliberately small. What matters is that the full path is real:

```
user command -> worker -> engine step -> checkpoint -> SQL batch -> Rust -> SQLite -> restart -> same world
```

Every later feature (weather, events, traffic) adds state and rules to this path. None of
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
- **Reference-data worker** (not drawn). A second worker that runs once at start-up, checks the
  bundled data pack against the database and installs it if needed, through the same SQL relay.
  It is discarded when it finishes (ADR 0013).
- **Map engine** (not drawn). `MapController` owns the MapLibre instance on the UI thread, outside
  React. MapLibre does its own tiling in its own worker (ADR 0014).

Setting `AEGIS_DATA_DIR` relocates all application data, for portable use and for testing a first
launch without touching the real profile.

## Packages

| Package         | Responsibility                                                             | May depend on        |
| --------------- | -------------------------------------------------------------------------- | -------------------- |
| `@aegis/domain` | Value types and pure rules: time, RNG, geodesy, flight, missions           | nothing              |
| `@aegis/sim`    | Engine, runner, fleet, missions, log, persistence port (`WorldStore`)      | `domain`             |
| `@aegis/db`     | Drizzle schema, migrations, SQL transport, `SqliteWorldStore`              | `domain`, `sim`      |
| `@aegis/ingest` | Reference pipeline: normalise, load, data pack, basemap preparation, CLI   | `domain`, `db`       |
| `@aegis/ui`     | Design tokens, token resolver for canvas renderers, every shared component | React, Radix, Lucide |
| `apps/desktop`  | Tauri shell, workers, IPC bridge, map engine, screens                      | all of the above     |

`domain` and `sim` compile without DOM or Node typings, and ESLint forbids them from importing UI,
platform or persistence code and from using `Date.now`, `Math.random`, timers, locale formatting
or any `Math` function that engines do not compute identically. A violation fails
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
- **Mathematics.** `Math.sin`, `cos`, `atan2`, `log` and their relatives differ in the last digit
  between JavaScript engines and engine versions. The simulation core uses its own versions
  (`packages/domain/src/math.ts`), built only from the operations the language guarantees exactly,
  so a world is the same world under any engine ([ADR 0020](adr/0020-deterministic-mathematics.md)).
- **Integrity digest.** Each step folds the tick number and one random draw into a rolling digest.
  Equal digests at equal ticks mean two runs executed identically. It is how tests, and the System
  screen, prove a world continued exactly across a restart.

Adding a subsystem means: add its state to `WorldSnapshot`, call it from `SimulationEngine.step()` in
a fixed position, give it its own RNG stream, persist its state in the same checkpoint batch, log
its commands and events, and bump `SIM_MODEL_VERSION` if existing worlds would behave differently.

The step order is fixed: the fleet moves aircraft, then missions read where they are, then the
integrity digest is updated.

### Command and event log

Every command that changed the world is recorded with its whole payload, and everything the world
did in response is recorded as an event, in one append-only table written in the checkpoint
transaction ([ADR 0018](adr/0018-command-log.md)). Rejected commands, commands with no effect and
pacing (pause, resume, speed) are not logged.

Because commands carry complete payloads, a world can be re-derived from its seed and its log
(`replayWorld`). That is used for verification, by the test suite and by `npm run verify:world`;
there is no replay feature.

## Fleet and flight

The decisions and every assumption are in [ADR 0016](adr/0016-fleet-and-flight-model.md).

- **Aircraft** are simulated instances (`AEGIS-FT-001`) of real reference types. Identity, fuel,
  load, condition, maintenance and history are `sim_*` state.
- **Reference data reaches the simulation in one place**, `apps/desktop/src/fleet/catalogue.ts`,
  and as a copy. An aircraft stores the performance model it was acquired with; a flight stores the
  coordinates of its route. The engine never reads `ref_*`.
- **Performance model** (`derivePerformance`): sourced mass, range, speed, ceiling and, where a
  source gives one, fuel capacity, plus named assumptions for everything the reference data lacks.
  A type missing a required characteristic has no model and cannot fly; nothing is substituted.
  Flight model 2 ([ADR 0019](adr/0019-sourced-fuel-capacity.md)).
- **Flight step** (`advanceFlight`): take-off, climb, cruise, descent, landing along great-circle
  legs, one simulation step at a time, inside the engine step.
- **Fuel**: the Breguet range equation, calibrated per type to its published range. Burn depends on
  type, current mass, phase, altitude and speed. Climbing and accelerating cost their energy.
- **Planning** (`evaluatePlan`): runs the same step function over the whole route, so the estimate
  equals the outcome in still air. Constraints are `block`, `warning` or `note`.
- **Commands**: `acquireAircraft`, `seedStarterFleet`, `setHome`, `setLoad`, `launchFlight`,
  `startMaintenance`, `updatePerformance`. A refused command throws `CommandRejected` and changes
  nothing.
- **Model migration**: `updatePerformance` moves a grounded aircraft to the current flight model.
  An airborne aircraft is refused and finishes its flight under the model it departed with.
- **Maintenance**: flying wears condition and accumulates hours; a due aircraft cannot launch until
  maintained, which takes simulated time.

| Layer                    | Where                                                          |
| ------------------------ | -------------------------------------------------------------- |
| Flight and fuel rules    | `packages/domain/src/flight/`                                  |
| Fleet state and commands | `packages/sim/src/fleet.ts`                                    |
| Persistence              | `packages/db/src/fleet-schema.ts`, `world-store.ts`            |
| Reference to simulation  | `apps/desktop/src/fleet/catalogue.ts`                          |
| Plan editing             | `apps/desktop/src/fleet/plan-edit.ts`                          |
| Map features and binding | `apps/desktop/src/map/flight-features.ts`, `flight-binding.ts` |

### Editing a plan on the map and in the panel

There is one draft, in `state/plan-store.ts`. The panel's controls and the map's drag handles both
change it through the same pure functions, and both render from it, so they cannot disagree. The
estimate and constraints are recomputed from the draft on every change.

A mission's route is edited in the same planner, on the same draft. The only difference is where
the draft goes when the player is done: saved to the mission, instead of launched.

### Drawing flights

The simulation publishes state about ten times a second. `flight-binding.ts` writes routes and
aircraft straight into MapLibre sources and, between updates, interpolates each aircraft along its
own route every animation frame. Interpolation is display only. React renders the panels; it never
renders a frame of aircraft movement.

## Missions

The decisions are in [ADR 0017](adr/0017-missions.md).

| Thing       | Owns                                        |
| ----------- | ------------------------------------------- |
| Mission     | Intent: type, objectives, timing, outcome   |
| Flight plan | Route, cruise altitude and speed, load      |
| Flight      | The simulated movement of one aircraft      |
| Aircraft    | Persistent state: fuel, condition, location |

- **One framework, ten templates.** A mission type is a `MissionTemplate`: route shape, suitable
  aircraft categories, default objectives, priority and timing. There is one mission
  implementation. Types are simulation categories; nothing is modelled beyond the flight.
- **Lifecycle.** `draft`, `planned`, `accepted`, `active`, then `completed` or `failed`;
  `cancelled` before launch. Generated opportunities start `offered` and may be `rejected` or
  `expired`. "Ready" is derived from the aircraft, not stored.
- **A mission never moves an aircraft.** `launchMission` launches a flight through the fleet,
  which validates it like any other. An aircraft committed to an accepted mission cannot be flown
  on anything else until it is released.
- **Objectives** are judged each step by a pure function of the mission's flight
  (`evaluateObjective`). The planner runs the same function over the planned flight, so the
  player sees what each objective will do before committing.
- **Validation** (`evaluateMission`) is the flight planner's constraints plus the mission's own,
  at the same three severities. A mission cannot relax a flight constraint.
- **Risk** is an index of named contributors, each with the reason for its value. It explains a
  plan and decides nothing.
- **Outcome.** When the flight ends the mission is completed if every required objective is
  complete, failed otherwise. A delivered payload is unloaded; a successful ferry rebases the
  aircraft. `MissionOutcome` is where later systems attach.
- **Opportunities.** Once per simulated hour the world may generate one, from its own seeded
  stream, anchored on an aircraft that can fly it. At most three wait for an answer; each expires.
  The places come from the **operating area**: public aerodromes the application copies into the
  world once, chosen by OurAirports size class and distance only.

| Layer                           | Where                                                            |
| ------------------------------- | ---------------------------------------------------------------- |
| Templates, objectives, risk     | `packages/domain/src/mission/`                                   |
| Mission state, commands, events | `packages/sim/src/missions.ts`                                   |
| Log and replay                  | `packages/sim/src/log.ts`, `replay.ts`                           |
| Persistence                     | `packages/db/src/mission-schema.ts`, `log-schema.ts`             |
| Form, readiness, operating area | `apps/desktop/src/missions/`                                     |
| Screens                         | `apps/desktop/src/features/missions/`                            |
| Map features and binding        | `apps/desktop/src/map/mission-features.ts`, `mission-binding.ts` |

## Persistence model

- **Checkpoint.** One transaction writes the clock, every RNG stream, the digest, the checkpoint
  sequence number, every aircraft, mission and flight in memory, the identifier counters and the
  log entries not yet on disk. The database always describes a single simulation instant, and
  never holds state without the log entries that explain it.
- **When.** Every 2 s of real time while the world is changing; immediately on pause, resume,
  speed change and every command; and when the window closes.
- **Ordering.** Writes never overlap. If one is in flight, the newest capture waits and replaces any
  older capture still waiting.
- **Failure.** A failed write is reported in the view, the world keeps running, and the next
  interval retries.
- **Restart.** `SimulationRunner.open` loads the checkpoint, validates it (Zod at the storage
  boundary, then engine invariants) and resumes. No simulated time passes while the app is closed.
- **Crash.** At most one checkpoint interval of progress is lost. What remains is consistent.

### Schema

| Table            | Rows | Contents                                                 |
| ---------------- | ---- | -------------------------------------------------------- |
| `sim_world`      | 1    | seed, simulation model version, epoch                    |
| `sim_clock`      | 1    | simulation time, tick, speed, running                    |
| `sim_checkpoint` | 1    | sequence number, wall-clock time, integrity digest       |
| `sim_rng_stream` | n    | one row per named RNG stream                             |
| `sim_aircraft`   | n    | one row per simulated aircraft                           |
| `sim_flight`     | n    | active and finished flights; finished ones are history   |
| `sim_counter`    | n    | next sequence number per identifier prefix               |
| `sim_mission`    | n    | every mission and opportunity; finished ones are history |
| `sim_place`      | n    | the operating area: aerodromes copied into the world     |
| `sim_log`        | n    | append-only command and event log                        |

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
into the simulation.

### Shell and routing

Seven areas: Overview, Operations, Fleet, Missions, Reports, Data, System. Operations (the map),
Fleet, Missions, Data and System exist and have routes. The others are listed in the rail, disabled, with the phase
that delivers them; there are no placeholder screens. The simulation clock stays in the top bar on
every screen (ADR 0015).

### Map

| Tier        | Content                                                  | Fed by                      |
| ----------- | -------------------------------------------------------- | --------------------------- |
| basemap     | Land, water, borders, graticule, country names           | Bundled Natural Earth files |
| reference   | Aerodromes, runways, cities (teal)                       | `ref_*` tables, read once   |
| simulation  | Aircraft, flight routes, missions (green); weather later | Simulation state            |
| interaction | Selection; the draft flight plan and its handles         | UI state                    |

Tiers are separated by slot layers and cannot interleave. The map is driven by `MapController`
methods, not by rendering components, so data updates never re-render React; that is the path
aircraft positions will take. Each location carries the lowest zoom at which it appears, so the
world view shows a few hundred places and all 55,000 arrive progressively. Details in ADR 0014.

Aircraft are redrawn every frame. Mission routes, waypoints and objective areas are redrawn only
when a mission is created, edited or changes state, through `addSimulationSource`.

`map/density.ts`, `map/features.ts`, `map/mission-features.ts` and `map/style.ts` are pure and unit
tested. `map/controller.ts`
needs a GPU and is verified by running the application.

## Testing

| Layer            | Tool                   | What it proves                                                                |
| ---------------- | ---------------------- | ----------------------------------------------------------------------------- |
| Domain           | Vitest, fast-check     | RNG reference vector, stream isolation, bounds, time and digest helpers       |
| Mathematics      | Vitest                 | Exact recorded bits of every function and of geodesy; accuracy against `Math` |
| Simulation       | Vitest                 | Determinism, every speed, pause/resume, catch-up cap, checkpoint policy       |
| Persistence      | Vitest + `node:sqlite` | Round trip, atomic rollback, constraints, restart continuity, crash recovery  |
| Native core      | `cargo test`           | Batch atomicity, statement guard, value conversion, migrations, backup, gate  |
| Ingestion        | Vitest + `node:sqlite` | Normalisation, idempotency, reproducibility, atomic failure, data pack        |
| Map              | Vitest                 | Tier order, density rules, feature building, style uses only palette colours  |
| Flight           | Vitest                 | Fuel calibration, phases, constraints, determinism, 1x equals 100x            |
| Scenario         | Vitest + `node:sqlite` | Starter fleet, plan, edit, launch, fly, save, reload, land, end to end        |
| Missions         | Vitest                 | Lifecycle, objectives, validation, risk, seeded generation, consequences      |
| Log              | Vitest + `node:sqlite` | Append-only, atomic with state, deterministic order, replay from seed         |
| Mission scenario | Vitest + `node:sqlite` | Create, route, edit, accept, launch, complete, reopen, generated offer        |

Persistence tests use the same Drizzle driver and SQL as production; only the transport differs.

Two tools check a real database independently of the code that wrote it:
`npm run verify:world` checks a saved world's continuity and re-derives the whole world from its
seed and its logged commands, and `npm run verify:reference` checks integrity, provenance and
source hashes and fingerprints the reference tables. `npx tsx tools/flyable-types.ts` lists which
reference types the flight model can fly and what each of the others lacks.

## Commands

| Command               | Does                                                        |
| --------------------- | ----------------------------------------------------------- |
| `npm run dev`         | Run the desktop app with hot reload                         |
| `npm run data:fetch`  | Download the pinned raw sources (needs a connection, once)  |
| `npm run data:build`  | Build the reference data pack and the offline basemap       |
| `npm run build`       | `data:build`, then the release executable and installer     |
| `npm run check`       | Format check, lint, type-check, TypeScript tests            |
| `npm run check:rust`  | `cargo fmt --check`, `clippy -D warnings`, `cargo test`     |
| `npm run ci`          | Both of the above; the single entry point for any CI system |
| `npm run db:generate` | Generate a migration from schema changes                    |
