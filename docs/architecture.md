# AEGIS architecture

This document describes how AEGIS is built as of phase 7. It is the map; the
[ADRs](adr/README.md) are the reasons. Product intent lives in the master handover specification.

## What exists today

Three things:

- **A simulated world**: a clock, seeded random streams, an integrity digest, a fleet of aircraft
  that fly planned routes between real aerodromes, missions that give those flights a purpose,
  opportunities the world generates, weather the aircraft fly through, events that close
  aerodromes and disrupt areas, commands that change a flight in the air, and an append-only log of everything that happened, all persisted
  and restored exactly.
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

Every later feature (traffic, an economy) adds state and rules to this path. None of them
should need to change its shape.

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
| `@aegis/domain` | Value types and pure rules: time, RNG, geodesy, flight, missions, reports  | nothing              |
| `@aegis/sim`    | Engine, runner, fleet, missions, events, log, persistence (`WorldStore`)   | `domain`             |
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

The step order is fixed: the fleet moves aircraft, then missions read where they are, then events
are announced, started and resolved, then the integrity digest is updated.

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
  Sourced fuel capacity is [ADR 0019](adr/0019-sourced-fuel-capacity.md).
- **Calibration** (flight model 3, [ADR 0023](adr/0023-range-conditions.md)): the range a type is
  calibrated to is used under the conditions its source states for it (ferry, with a stated
  payload, or at maximum mass). A ferry range flown with external fuel is never used, so a type
  whose only published range is one has no model.
- **Flight step** (`advanceFlight`): take-off, climb, cruise, descent, landing along great-circle
  legs, one simulation step at a time, inside the engine step.
- **Fuel**: the Breguet range equation, calibrated per type to its published range. Burn depends on
  type, current mass, phase, altitude and speed. Climbing and accelerating cost their energy.
- **Planning** (`evaluatePlan`): runs the same step function over the whole route, through the
  weather the flight will meet at the times it will meet it, so the estimate equals the outcome
  for a stated departure time. Constraints are `block`, `warning` or `note`.
- **Commands**: `acquireAircraft`, `seedStarterFleet`, `setHome`, `serviceAircraft`,
  `stopServicing`, `launchFlight`, `startMaintenance`, `updatePerformance`, and the in-flight
  commands below. A refused command throws `CommandRejected` and changes nothing.
- **Model migration**: `updatePerformance` moves a grounded aircraft to the current flight model.
  An airborne aircraft is refused and finishes its flight under the model it departed with.
- **Maintenance**: flying wears condition and accumulates hours; a due aircraft cannot launch until
  maintained, which takes simulated time.
- **On the ground**: an aircraft that lands is serviced before it is available, and fuel takes
  time to load. See [Ground servicing](#ground-servicing).

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
  on anything else until it is released. Accepting a mission begins loading its fuel; the mission
  launches when its aircraft is ready ([ADR 0027](adr/0027-ground-servicing.md)).
- **Objectives** are judged each step by a pure function of the mission's flight
  (`evaluateObjective`). The planner runs the same function over the planned flight, so the
  player sees what each objective will do before committing.
- **Validation** (`evaluateMission`) is the flight planner's constraints plus the mission's own,
  at the same three severities. A mission cannot relax a flight constraint.
- **Risk** is an index of named contributors, each with the reason for its value. It explains a
  plan and decides nothing. A mission keeps two assessments and changes neither afterwards:
  `acceptance`, what the operator accepted, and `assessment`, evaluated again at launch for the
  actual departure ([ADR 0024](adr/0024-reports.md)).
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

## Environment and events

The decisions are in [ADR 0021](adr/0021-environment.md) and [ADR 0022](adr/0022-world-events.md).

- **Weather is computed, not stored.** `conditionsAt(model, tick, position, altitude)` is a pure
  function of the world seed, the tick and the place: smooth noise on the sphere and in time. It
  holds no state, draws from no random stream and is not persisted. The planner, the engine, the
  Overview and the map all call the same function, so they cannot disagree, and replay needs
  nothing extra.
- **The forecast is exact.** What the planner shows for a departure time is what the simulation
  flies. Forecast uncertainty is not modelled.
- **What weather changes.** Four things act on a flight: wind along the track (ground speed),
  crosswind (the aircraft crabs, losing speed along the track), temperature (fuel and climb
  rate) and precipitation (fuel). Each has a
  stated size in `ENVIRONMENT_EFFECTS`. Visibility and cloud base are warnings and risk only.
  Weather never fails a flight by itself; it can only cost time and fuel.
- **Sampling.** A flight samples the weather where it is once per simulated minute and holds it
  between samples. The held sample is part of the flight's state and is checkpointed.
- **Against still air.** Every estimate carries the same plan, with the same load, flown in still
  air, so the cost of the weather is a stated difference and not an impression.
- **Events** have a lifecycle (`scheduled`, `active`, `resolved`) and one of five types. Four are
  generated from the world's own seeded stream at a controlled rate, at places in the operating
  area. Severe weather is not rolled: it is read from the weather field.

| Event                 | Consequence                                                                       |
| --------------------- | --------------------------------------------------------------------------------- |
| Aerodrome closure     | No departure from it; no plan arriving during it. Airborne aircraft hold short    |
| Navigation disruption | A warning and more risk for a route through the area                              |
| Logistics disruption  | An urgent delivery is offered while it lasts                                      |
| Maintenance finding   | The aircraft is due maintenance and cannot launch until it is done                |
| Severe weather        | None of its own: the weather itself is the effect                                 |
| Technical caution     | Shown on an airborne aircraft: faster wear while it flies, maintenance on landing |

A closure announced while an aircraft is on its way is handled in the air: see
[In-flight control](#in-flight-control).

- **Risk** gained six contributors (wind, weather on the route, visibility, precipitation,
  temperature, events), each with its reason, beside the seven from missions.
- **Operating area.** When a home base changes and the fleet's centre has moved 250 km or more,
  the area is rebuilt around the new centre, by a logged command. Open offers are kept.

| Layer                    | Where                                                                    |
| ------------------------ | ------------------------------------------------------------------------ |
| Weather field            | `packages/domain/src/environment/weather.ts`                             |
| Weather acting on flight | `packages/domain/src/environment/flight-weather.ts`, `flight/profile.ts` |
| Event rules              | `packages/domain/src/event/`                                             |
| Event state and stepping | `packages/sim/src/events.ts`                                             |
| Persistence              | `packages/db/src/event-schema.ts`                                        |
| Screen                   | `apps/desktop/src/features/overview/`                                    |
| Map features and binding | `apps/desktop/src/map/environment-features.ts`, `environment-binding.ts` |

## In-flight control

The decisions are in [ADR 0026](adr/0026-in-flight-control.md).

- **One primitive.** `reviseFlight` replaces the rest of an airborne flight's route, with an
  intent: reroute, divert or return to base. The route flown so far is kept, a waypoint is put
  where the aircraft is, and the new remainder follows. The plan as launched is kept beside it
  (`plannedPlan`), with a history of every revision.
- **Preview equals outcome.** `evaluateRevision` and `projectFlight` fly the rest of the flight
  with the step the engine itself runs, through the same weather and the same known closures. The
  arrival time and landing fuel shown before a change are the ones recorded when the aircraft
  lands; the tests assert this exactly. A revision is refused, with its reason, during the
  take-off roll, to somewhere that is not an aerodrome, without the fuel to arrive above reserve,
  or to somewhere nearer than the distance a descent needs.
- **Holding.** `holdFlight` and `resumeFlight` are the operator's. A hold is flown where the
  aircraft is, at a stated fraction of cruise speed, and ends on resume, on a revision, or when
  fuel is down to reserve.
- **A closed destination.** At the top of its descent, an aircraft whose destination is closed
  holds short of it. It lands when the aerodrome reopens, goes elsewhere if the operator diverts
  it, and lands despite the closure if its fuel reaches reserve first; that landing is recorded
  as such and the aircraft is then due maintenance. An aircraft already descending is committed.
  Nothing is decided for the operator and nothing is moved.
- **The arrival shown is kept true.** A flight's projected arrival and landing fuel are worked out
  again whenever it is revised, a hold ends, or the closures known for its destination change.
- **Aborting a mission** (`abortMission`) is immediate. Objectives already complete stay complete;
  those pending fail with the reason "Mission aborted". The aircraft flies on as an ordinary
  flight to wherever the operator chose: on to its destination, back to base, or to an alternate.
- **Where it landed decides.** Objectives that depend on a place (complete the flight, deliver a
  payload, arrive by a time) are judged on the aerodrome the aircraft landed at, and a failure
  names both places.
- **Technical caution.** One event type from the seeded event system, on an aircraft in the air.
  It wears faster while it flies and is due maintenance when it lands. It is not a failure model.
- **Advisories are derived.** What the panel says about a flight (closed on arrival, holding,
  caution, fuel) is computed from the world's state when it is shown; only what happened is
  logged (`flightHolding`, `flightHoldEnded`, the commands, the events).

| Layer                       | Where                                                                    |
| --------------------------- | ------------------------------------------------------------------------ |
| Revision, projection        | `packages/domain/src/flight/revision.ts`                                 |
| Holding, closure on arrival | `packages/domain/src/flight/profile.ts`, `environment/flight-weather.ts` |
| Commands and stepping       | `packages/sim/src/fleet.ts`, `missions.ts`, `events.ts`                  |
| What the panel offers       | `apps/desktop/src/operations/inflight-logic.ts`                          |
| Panels                      | `apps/desktop/src/features/operations/`                                  |

Simulation model 6. A world saved by an earlier model loads and upgrades: its flights are as
launched, and from the upgrade tick the closure rule applies to every flight, including one
already in the air. As with every model change, such a world's log is complete for replay only
from the upgrade.

## Ground servicing

The decisions are in [ADR 0027](adr/0027-ground-servicing.md).

An aircraft is in exactly one of six states. Whether it is committed to a mission is not one of
them: that is the accepted or active mission that names it.

| Status            | On the ground | Can be launched | Becomes available                   |
| ----------------- | ------------- | --------------- | ----------------------------------- |
| `available`       | yes           | yes, if fuelled | —                                   |
| `servicing`       | yes           | no              | by itself, when the service ends    |
| `maintenance_due` | yes           | no              | when the operator has it maintained |
| `in_maintenance`  | yes           | no              | by itself, when maintenance ends    |
| `unserviceable`   | yes           | no              | when maintenance has recovered it   |
| `in_flight`       | no            | no              | after it lands and is turned round  |

- **One record.** While it is `servicing` an aircraft carries one `service`: why (`turnaround`
  after landing, `preparation` for a flight), its stage (`checks`, then `refuelling`), when the
  checks end, the fuel to end with, and the fuel transfer under way. The record exists exactly
  while the status is `servicing`; a saved world that says otherwise is refused.
- **Landing begins a turnaround.** A healthy aircraft is checked, for a time set by the flight it
  has just made, and is then available with the fuel it landed with. An aircraft that lands due
  maintenance is not turned round: maintenance is what it waits for, exactly as before.
- **Fuel takes time.** `serviceAircraft` brings an aircraft's fuel to a quantity: a time to
  connect, then the quantity at a rate set by the size of its tanks. More fuel takes longer, and
  taking fuel off takes as long as putting it on. Given during the checks, the fuel follows them.
  `stopServicing` ends a transfer where it is; checks cannot be skipped.
- **Computed, not accumulated.** The fuel aboard during a transfer is a function of the transfer
  and the tick. The step writes that figure; it never adds to the last one. A world saved
  part-way continues to the same completion tick and the same fuel, at any speed, and the target
  is reached exactly. Nothing is logged per step; what a screen shows is derived the same way.
- **A launch flies what is aboard.** It no longer sets the fuel. It requires the planned fuel to
  be aboard and is refused, with the difference and the time to load it, when it is not. So an
  estimate still equals the outcome.
- **Missions.** Accepting a mission commits its aircraft and begins loading its fuel; if the
  aircraft is still in its post-flight checks the fuel follows them. The launch is refused until
  the aircraft is ready, and nothing launches by itself.
- **One readiness rule.** `launchReadiness` decides whether an aircraft can launch a load from a
  place now, and why not. The fleet's launch calls it to refuse; the planner, the mission page,
  the fleet screen and the aircraft panel call it to explain. No component decides readiness.
- **Commands report what they caused.** A command that starts or ends a service is followed in
  the log by the events it caused (`servicingStarted`, `refuellingStarted`,
  `refuellingCompleted`, `servicingCompleted`), the same events the step writes when a stage
  changes by itself. A refused command leaves none.
- **The fuel offered allows for the wait.** A flight now leaves after its preparation, in weather
  that has moved on, so the fuel a plan or a mission is offered is what arrives on the reserve
  plus a contingency on the trip fuel (`offeredFuelKg`).
- **Times are simulation assumptions**, stated in the interface (`GROUND_SERVICE`). They are not
  reference data, and are the same at every aerodrome.

| Layer                     | Where                                                |
| ------------------------- | ---------------------------------------------------- |
| Rules, times, readiness   | `packages/domain/src/ground/service.ts`              |
| State, commands, stepping | `packages/sim/src/fleet.ts`                          |
| A mission's preparation   | `packages/sim/src/missions.ts`                       |
| Persistence               | `packages/db/src/fleet-schema.ts`, `world-store.ts`  |
| What the screens say      | `apps/desktop/src/fleet/ground-logic.ts`             |
| Panel and fuel control    | `apps/desktop/src/features/shared/GroundService.tsx` |

Simulation model 7. A model-6 world loads and upgrades: none of its aircraft is being serviced.
From the upgrade tick a landing begins a turnaround and a launch needs its fuel aboard, so a
mission accepted under model 6 waits for its aircraft to be prepared, which its page offers.
Migration 0009 adds one nullable column, `sim_aircraft.service`; no table is rebuilt.

## Reports

The decisions are in [ADR 0024](adr/0024-reports.md) and [ADR 0025](adr/0025-report-export.md).

- **Derived, not stored.** A report is computed on demand from `sim_flight`, `sim_mission`,
  `sim_event` and `sim_log`. There are no counters and no summary tables, and the engine does not
  know reports exist. A report cannot disagree with the world because it holds nothing of its own.
- **One read, one checkpoint.** `loadReportData` reads everything in a single batch, which the
  native side runs in one transaction. Pure functions in `packages/domain/src/report/` turn the
  rows into a `Report`. The screens read at most every five seconds while the world runs.
- **Periods are simulation time**: a half-open range of ticks. Today, the last 24 hours, 7 days
  and 30 days are measured back from the simulation clock; a custom period is typed as simulation
  UTC. Wall-clock time is never used.
- **Attribution.** A flight, a mission or a maintenance visit belongs to the period in which it
  finished, with the figures recorded when it did. An event belongs to every period it was open
  in. Periods therefore add up, and a past period does not change when aircraft later do.
- **Status history comes from the log.** Each aircraft's time available, airborne, due
  maintenance, in maintenance and unserviceable is rebuilt from the transitions the log records.
  Availability and utilisation are shares of the time the aircraft was owned in the period. They
  are AEGIS simulation metrics and are labelled as such. Time before the log began is reported as
  not recorded.
- **Cost follows the period, not the age of the world.** A report reads the status transitions in
  its window and, for each aircraft, the last one before it, which the database finds. A month
  from a history of 10,000 flights and 100,000 log entries is read in about a tenth of a second,
  with no index beyond those the log already has.
- **Planned and actual.** A flight record carries where it was launched for and where it landed,
  its revisions, the time it held and whether it landed during a closure. Fuel is compared with
  the estimate made at launch only for flights flown as launched: an estimate for one route says
  nothing about another. Missions aborted are counted on their own.
- **Ground operations.** A finished ground service is read from the log like a finished flight:
  what it was, how long it took, how long it spent on fuel and what it loaded or took off, and
  the mission it was for. It belongs to the period in which it finished. Time being serviced is
  part of each aircraft's status history and counts against availability, as time down for
  maintenance does.
- **In progress is shown apart.** Flights in the air and missions under way are listed as they
  stand, and are in no total: totals are of what has finished.
- **Drill-down, not duplication.** Every mission, aircraft and event a report names opens its own
  existing page. Reports have no detail pages.
- **Export.** A section is exported as it is filtered on screen, as CSV or JSON, by pure
  functions; one native command writes the text to the exports folder.

| Layer                   | Where                                                      |
| ----------------------- | ---------------------------------------------------------- |
| Periods, summaries      | `packages/domain/src/report/period.ts`, `summary.ts`       |
| Status history          | `packages/domain/src/report/timeline.ts`                   |
| CSV and JSON            | `packages/domain/src/report/export.ts`                     |
| Reads                   | `packages/db/src/report-queries.ts`                        |
| Writing the export file | `apps/desktop/src-tauri/src/export.rs`                     |
| Period, sorting, series | `apps/desktop/src/reports/`                                |
| Screens                 | `apps/desktop/src/features/reports/`                       |
| Charts                  | `packages/ui/src/charts/option.ts`, `components/Chart.tsx` |

## Persistence model

- **Checkpoint.** One transaction writes the clock, every RNG stream, the digest, the checkpoint
  sequence number, every aircraft, mission, flight and event in memory, the identifier counters
  and the log entries not yet on disk. The database always describes a single simulation instant, and
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
| `sim_aircraft`   | n    | one row per simulated aircraft, with its ground service  |
| `sim_flight`     | n    | active and finished flights; finished ones are history   |
| `sim_counter`    | n    | next sequence number per identifier prefix               |
| `sim_mission`    | n    | every mission and opportunity; finished ones are history |
| `sim_place`      | n    | the operating area: aerodromes copied into the world     |
| `sim_log`        | n    | append-only command and event log                        |
| `sim_event`      | n    | world events; resolved ones are history                  |

Singleton tables enforce `id = 1` with a CHECK constraint. Table prefixes separate families:
`ref_` (sourced reference data), `sim_` (simulated world), `sys_` (application records).

### Changing the schema

1. Edit `packages/db/src/schema.ts`.
2. `npm run db:generate -- --name <what_changed>` writes a SQL migration.
3. Read the migration before committing it. A migration runs inside one transaction with foreign
   keys on, where SQLite ignores `PRAGMA foreign_keys`; a generated table rebuild that relies on
   switching them off fails there. Migration 0008 is written by hand for that reason: it sets the
   links from flights to missions aside and restores them around the rebuild.
4. Commit the migration. Never edit a migration that has been applied anywhere: both runners
   compare checksums and refuse to start.

At startup the Rust core applies pending migrations, each in its own transaction, after taking a
`VACUUM INTO` backup if the database already holds data.

## Native core command surface

| Command         | Purpose                                            | Gated |
| --------------- | -------------------------------------------------- | ----- |
| `db_query`      | Run one data statement                             | yes   |
| `db_batch`      | Run statements in one all-or-nothing transaction   | yes   |
| `app_info`      | Version, database path, SQLite version, gate state | no    |
| `export_report` | Write report text to the exports folder            | yes   |

Only `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `REPLACE` and `WITH` statements are accepted over IPC.
`export_report` writes only into `exports` in the data directory, under a name it validates, and
never overwrites; the window has no other access to the file system.

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

Seven areas: Overview, Operations, Fleet, Missions, Reports, Data, System. All exist and have
routes. Overview is the environment and the world's events. Reports interprets what the world has
recorded; Data remains the place for reference datasets and their provenance, and System for the
technical log and diagnostics. The simulation clock stays in the top bar on
every screen (ADR 0015).

### Map

| Tier        | Content                                             | Fed by                      |
| ----------- | --------------------------------------------------- | --------------------------- |
| basemap     | Land, water, borders, graticule, country names      | Bundled Natural Earth files |
| reference   | Aerodromes, runways, cities (teal)                  | `ref_*` tables, read once   |
| simulation  | Aircraft, routes, missions (green); weather; events | Simulation state            |
| interaction | Selection; the draft flight plan and its handles    | UI state                    |

Tiers are separated by slot layers and cannot interleave. The map is driven by `MapController`
methods, not by rendering components, so data updates never re-render React; that is the path
aircraft positions will take. Each location carries the lowest zoom at which it appears, so the
world view shows a few hundred places and all 55,000 arrive progressively. Details in ADR 0014.

Aircraft are redrawn every frame. Mission routes, waypoints and objective areas are redrawn only
when a mission is created, edited or changes state, through `addSimulationSource`.

Weather is two optional layers, precipitation and wind at cruise level, sampled on a grid over
the visible map: coarse when zoomed out, finer when zoomed in, never more than about 700 points.
It is resampled when the view moves and every ten simulated minutes. Events are drawn in amber
and only redrawn when one is announced, starts or ends.

`map/density.ts`, `map/features.ts`, `map/mission-features.ts`, `map/environment-features.ts` and
`map/style.ts` are pure and unit tested. `map/controller.ts`
needs a GPU and is verified by running the application.

## Testing

| Layer            | Tool                   | What it proves                                                                 |
| ---------------- | ---------------------- | ------------------------------------------------------------------------------ |
| Domain           | Vitest, fast-check     | RNG reference vector, stream isolation, bounds, time and digest helpers        |
| Mathematics      | Vitest                 | Exact recorded bits of every function and of geodesy; accuracy against `Math`  |
| Simulation       | Vitest                 | Determinism, every speed, pause/resume, catch-up cap, checkpoint policy        |
| Persistence      | Vitest + `node:sqlite` | Round trip, atomic rollback, constraints, restart continuity, crash recovery   |
| Native core      | `cargo test`           | Batch atomicity, statement guard, value conversion, migrations, backup, gate   |
| Ingestion        | Vitest + `node:sqlite` | Normalisation, idempotency, reproducibility, atomic failure, data pack         |
| Map              | Vitest                 | Tier order, density rules, feature building, style uses only palette colours   |
| Flight           | Vitest                 | Fuel calibration, phases, constraints, determinism, 1x equals 100x             |
| Scenario         | Vitest + `node:sqlite` | Starter fleet, plan, edit, launch, fly, save, reload, land, end to end         |
| Missions         | Vitest                 | Lifecycle, objectives, validation, risk, seeded generation, consequences       |
| Log              | Vitest + `node:sqlite` | Append-only, atomic with state, deterministic order, replay from seed          |
| Mission scenario | Vitest + `node:sqlite` | Create, route, edit, accept, launch, complete, reopen, generated offer         |
| Environment      | Vitest                 | Recorded bits of the weather field, continuity, effects, estimate equals flown |
| Events           | Vitest + `node:sqlite` | Lifecycle, seeded generation, consequences, persistence, replay                |
| World scenario   | Vitest + `node:sqlite` | Weather on a mission, a closure, a finding, save mid-flight, reopen, replay    |
| Reports          | Vitest                 | Periods and boundaries, totals, status history, immutability, determinism      |
| Report reads     | Vitest + `node:sqlite` | Totals equal the engine's counters; reopen, crash, replay; volume              |
| Export           | Vitest, `cargo test`   | CSV and JSON content and filtering; the file name guard; no overwrite          |
| Charts           | Vitest                 | Order, tones from tokens only, empty state, no colour literal                  |
| Report scenario  | Vitest + `node:sqlite` | Missions to different ends, maintenance, reports, export, reopen, replay       |
| In-flight        | Vitest                 | Revision, hold, closure on arrival, abort, caution; preview equals outcome     |
| In-flight store  | Vitest + `node:sqlite` | Reopen mid-diversion and mid-hold; migration of a database from before 0008    |
| Control scenario | Vitest + `node:sqlite` | Divert, reroute, abort after an objective, reopen, reports, replay             |
| Ground rules     | Vitest, fast-check     | Times, fuel at any tick, exact completion, every state of the readiness rule   |
| Servicing        | Vitest                 | Turnaround, refuelling, refusals, missions, 1x and 100x, save at any tick      |
| Servicing store  | Vitest + `node:sqlite` | Reopen mid-refuel, crash recovery; migration of a database from before 0009    |
| Ground scenario  | Vitest + `node:sqlite` | Land, turn round, refuel, close and reopen, launch when ready, reports, replay |

Persistence tests use the same Drizzle driver and SQL as production; only the transport differs.

Two tools check a real database independently of the code that wrote it:
`npm run verify:world` checks a saved world's continuity and re-derives the whole world from its
seed and its logged commands, and `npm run verify:reference` checks integrity, provenance and
source hashes and fingerprints the reference tables. `npx tsx tools/flyable-types.ts` lists which
reference types the flight model can fly and what each of the others lacks.

`npx tsx tools/scenario-world.ts <closure|caution|turnaround> <database>` builds a saved world in
which an aircraft is bound for an aerodrome the world has just announced it will close, is flying
with a technical caution, or has just landed and is in its post-flight checks. Nothing is injected: seeds are searched until the world's own events produce
the situation, so the result replays like any other world. It is for checking a build by hand.

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
