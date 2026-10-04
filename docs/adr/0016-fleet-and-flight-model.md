# 0016 — Fleet state and the flight model

- Status: Accepted
- Date: 2026-10-04

## Context

Phase 4 adds simulated aircraft that fly between real aerodromes. Aircraft types and their published
characteristics are reference data (`ref_*`). Individual aircraft, their fuel, condition and flights
are simulated state (`sim_*`). The simulation must stay deterministic, and it must not present a
number as authoritative when the reference data cannot support it.

The reference data holds, per type and only where a source states it: empty mass, maximum take-off
mass, cruise and maximum speed, range, ferry range and service ceiling. It holds **no** fuel
capacity, fuel burn or climb rate for any type.

## Decision

### Reference and simulation stay separate

- An aircraft is a row in `sim_aircraft` with a fictional identifier (`AEGIS-FT-001`). It names its
  type by reference id but is never written to `ref_*`.
- **The engine never reads reference tables.** When an aircraft is acquired, the application
  derives a performance model from the type's sourced characteristics and the aircraft stores that
  model. A flight stores the resolved coordinates of its route. A saved world therefore replays
  identically even if reference data is later updated, and restores even if it is absent.
- Reference ids held by simulated rows are soft links for that reason. Links between simulated
  rows (flight to aircraft) are real foreign keys.

### Performance model: sourced inputs, named assumptions

`derivePerformance` (in `@aegis/domain`) turns sourced characteristics into the numbers the flight
model needs. It requires empty mass, maximum take-off mass, a range and a speed. If any is missing
the result is "unavailable" with the list of what is missing; the aircraft can exist but cannot
fly. Nothing is substituted.

Everything not in the reference data is a **simulation assumption**, defined once in
`FLIGHT_ASSUMPTIONS`, versioned by `FLIGHT_MODEL_VERSION`, stored with each aircraft and shown in
the interface as an assumption, never as a specification:

| Assumption                  | Value                                                             |
| --------------------------- | ----------------------------------------------------------------- |
| Fuel capacity               | Half of useful load (maximum take-off mass minus empty mass)      |
| Published range condition   | Full fuel, take-off at maximum mass (ferry range: no payload)     |
| Reserve                     | 10 % of fuel capacity                                             |
| Cruise speed, if unsourced  | The lesser of 85 % of maximum speed and 900 km/h                  |
| Cruise altitude             | 80 % of service ceiling, at most 11,500 m; rotorcraft 900 m       |
| Climb rate at sea level     | By engine type: jet 15 m/s (fast jet 60), turboprop 9, rotor 7, piston 5 |
| Climb rate with altitude    | Falls linearly to 30 % at the service ceiling                     |
| Descent path                | 3 degrees                                                         |
| Speeds                      | Lift-off 40 %, climb 75 %, approach 45 % of cruise speed          |
| Acceleration                | 1.5 m/s² (fast jet 4 m/s²)                                        |
| Propulsive energy per kg fuel | 12.9 MJ (43 MJ/kg at 30 % overall efficiency)                   |
| Off-optimum altitude        | Up to 50 % more cruise fuel at sea level, quadratic               |
| Off-optimum speed           | Fuel per distance rises with the square of the speed error        |
| Descent fuel                | Half the cruise rate                                              |
| Wear                        | 0.4 % condition per flight hour, 0.5 % per flight, ±10 % seeded   |
| Maintenance                 | Due at 50 flight hours or below 60 % condition; takes 6 hours     |

### Fuel

Cruise fuel follows the Breguet range equation. A type's published range, with the assumed fuel
capacity and reserve, fixes one constant, the **range factor** `K`:

```
K = range / ln(m_takeoff / (m_takeoff - usable_fuel))
fuel burned per metre in cruise = current mass / K
```

Fuel burn therefore depends on the aircraft type, on its current mass (a heavier aircraft burns
more, and burns less as fuel is used), and, through the factors above, on altitude and speed.
Climbing and accelerating cost the energy they physically require, converted to fuel at the
assumed efficiency. With full assumed fuel at the published condition an aircraft achieves its
published range: the model is calibrated to the one figure a source actually gives.

Absolute fuel masses are simulated quantities. The interface says so.

### Flight

- A flight is advanced by `advanceFlight`, one simulation step at a time, inside the existing
  engine step. There is no second clock.
- Phases: take-off, climb, cruise, descent, landed. A route is a list of great-circle legs between
  an origin aerodrome, optional free waypoints and a destination aerodrome.
- **The planner runs the same step function** over the whole route to produce distance, time, fuel
  and arrival estimates. Estimate and outcome agree exactly in still air.
- Environment is an explicit input (`still air, standard atmosphere` in this phase). Wind and
  weather arrive in phase 6 through that input, without changing the model's shape.

### Constraints

| Level   | Meaning                                  | Examples                                                         |
| ------- | ---------------------------------------- | ---------------------------------------------------------------- |
| block   | Cannot be flown                          | Above the service ceiling; over maximum mass; not enough fuel to arrive; aircraft not at the origin or not serviceable |
| warning | Outside the normal envelope; allowed     | Arrival below reserve; cruise far from the assumed optimum speed |
| note    | Poor but legitimate; allowed, has a cost | Low cruise altitude; a limit the reference data cannot check     |

Poor choices are allowed and cost fuel, time or wear.

### Load

`payloadKg` is a single benign mass. It is carried as a `LoadConfiguration` union with one variant
today (`simple`), so a transport type can later gain a more detailed variant without changing the
flight model, which only ever asks for total mass. No weapon or mission payload is modelled.

### Maintenance and acquisition

- Flying consumes condition and accumulates hours. An aircraft that is due cannot launch until the
  player starts maintenance, which takes simulated time and restores it.
- Acquiring an aircraft creates an instance of a real reference type at a chosen home aerodrome,
  fuelled and serviceable. There is no cost: no economy exists yet, and no purchase price is
  invented.
- A new world receives a small starter fleet once, when reference data is available. The fleet and
  its basing are fictional (ADR 0011).

### Engine and persistence

- `SIM_MODEL_VERSION` becomes 2. A model-1 world (clock only) is upgraded on load to a model-2
  world with an empty fleet.
- Commands (`acquireAircraft`, `launchFlight`, `startMaintenance`, ...) are the only way the fleet
  changes. Each effective command checkpoints (ADR 0004).
- Aircraft, flights and counters are written in the same checkpoint transaction as the clock and
  RNG state. Nested structures (performance model, plan, progress) are JSON columns.
- Completed flights stay in the database as history; the engine keeps only recent ones in memory.

## Consequences

- 23 of the 40 reference types can fly. The other 17 lack a sourced mass, range or speed, and say
  so. Adding the missing reference values makes a type flyable with no code change.
- Fuel quantities are plausible and internally consistent, not authoritative. A sourced fuel
  capacity or climb rate, when added to the reference data, replaces its assumption.
- A change to any assumption changes outcomes for new aircraft only; existing aircraft carry the
  model they were acquired with, until a deliberate migration.
- There is no command log, so a saved world cannot be re-derived from its seed alone once the
  player has acted. Determinism is proven by tests that issue the same commands at the same ticks.
