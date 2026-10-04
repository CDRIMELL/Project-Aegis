# 0017 — Missions

- Status: Accepted
- Date: 2026-10-04

## Context

Phase 4 gave the simulation aircraft that can be planned and flown. Phase 5 adds operational
intent: missions the player creates and opportunities the world generates. The mission layer must
sit on the existing deterministic engine, must not duplicate the flight planner, and must remain an
abstract simulation: no targeting, engagement or real operational planning (ADR 0011).

## Decision

### Four separate things

| Thing       | Owns                                        | Where                    |
| ----------- | ------------------------------------------- | ------------------------ |
| Mission     | Intent: type, objectives, timing, outcome   | `sim_mission`            |
| Flight plan | Route, cruise altitude and speed, load      | JSON on mission / flight |
| Flight      | The simulated movement of one aircraft      | `sim_flight`             |
| Aircraft    | Persistent state: fuel, condition, location | `sim_aircraft`           |

A mission never moves an aircraft. Launching a mission launches a flight through the same
`launchFlight` path as any other flight, which re-validates the plan. A mission cannot bypass a
flight constraint.

**One mission is one aircraft and one flight** in this phase. Out-and-back types return to their
origin within the single flight; point-to-point types end at the destination. `sim_flight.mission_id`
allows several flights per mission later.

### One framework, ten templates

Mission types are data. A `MissionTemplate` gives a type its default title, suitable aircraft
categories, route shape (`point_to_point`, `out_and_back`, `orbit`), default objectives, priority
and timing. The player may change the aircraft, route, timing and load of any mission. There is one
mission implementation.

Types: training, patrol, reconnaissance, logistics, transport, ferry, emergency response,
intercept, search and rescue, exercise. These are game categories. "Intercept" means reaching a
fictional simulated point within a time window; nothing is modelled beyond the flight.

### Lifecycle

```
offered ──accept──▶ planned ──accept──▶ accepted ──launch──▶ active ──▶ completed
   │                   ▲                    │                    └────▶ failed
   ├─reject─▶ rejected │                    └─cancel─▶ cancelled
   └─expiry─▶ expired  draft (manual creation starts here)
```

- `draft`: being configured; may lack an aircraft or a route.
- `planned`: has an aircraft, a route and a load.
- `accepted`: committed. The aircraft is assigned and cannot be used for another flight.
- `active`: its flight is airborne.
- `completed` / `failed`: decided by objectives when the flight ends, or earlier if a required
  objective fails.
- `cancelled`: withdrawn by the player before launch. `accepted` missions whose deadline passes
  unlaunched fail.
- `offered`, `rejected`, `expired`: generated opportunities only.

**"Ready" is derived**, not stored: an accepted mission is ready when its aircraft is available, at
the origin, and its plan has no blocking constraint. It depends on state that changes every step.

**There is no in-flight abort.** A flight cannot be re-planned after launch (ADR 0016), so an abort
would need diversion, which is a flight-model feature for a later phase.

### Objectives

An objective is a member of a discriminated union with a status (`pending`, `complete`, `failed`),
a progress fraction and a pure evaluator that reads the mission's flight and aircraft each step.
Adding an objective type is adding a union member and an evaluator.

First set: reach destination, visit waypoint, remain in area for a duration, deliver payload,
return to base, arrive within a time window, land with reserve fuel, keep aircraft condition above
a threshold.

**Loiter is a route, not a flight phase.** "Remain in area" is satisfied by time spent within a
radius of a point; the template generates orbit waypoints that produce that time. The flight model
is unchanged.

### Risk

Risk is an index from 0 to 100 built from named contributors, each with a value, a weight and a
sentence explaining it: fuel margin, distance against the type's range, aircraft condition, hours
before maintenance is due, time slack, aircraft suitability and limits the reference data could not
check. It is a simulation index and is labelled as one.

**Risk explains; it does not roll dice.** Outcomes come from objectives and the flight model.
Random failure belongs with the events of phase 6.

### Validation

`evaluateMission` returns the flight-plan constraints from `evaluatePlan` plus mission-level
constraints, at the same three severities (block, warning, note). An unsuitable aircraft is a
warning and a risk contributor, not a block.

### World-generated opportunities

- The engine never reads reference tables (ADR 0016), so it knows no places. The application
  copies an **operating area** into the world once, in a logged command: a bounded set of public
  aerodromes near the fleet's bases, chosen by OurAirports size class only. No military
  classification is inferred or stored.
- Generation runs once per simulated hour from its own seeded stream (`missions.generation`),
  offers at most three opportunities at a time, and gives each an expiry. Same seed and same
  commands give the same offers.
- Opportunities are simulated events, stored in `sim_*`, and shown as simulated.

### Consequences of a mission

Completion and failure are recorded on the mission (`MissionOutcome`) and in the log. Normal wear
applies through the flight. A delivered payload is unloaded. `MissionOutcome` is the extension
point for reputation or readiness; no economy is built in this phase.

### Engine and persistence

- `Missions` is a second subsystem, stepped after the fleet in the same fixed step.
- `SIM_MODEL_VERSION` becomes 3. A model-2 world is upgraded on load with no missions.
- Missions are written in the same checkpoint transaction as everything else.

## Correction to ADR 0016

ADR 0016 states that 23 of the 40 reference types could fly and 17 could not. The correct figures
at that time were **22 and 18**.

## Consequences

- A mission that needs a hold costs route distance and fuel like any other route.
- Multi-aircraft and multi-leg missions, in-flight abort and random events are deferred.
- Generated opportunities depend on the operating area; a world without one generates nothing.
