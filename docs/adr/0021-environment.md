# 0021 — Simulated environment

- Status: Accepted
- Date: 2026-10-04

## Context

Until now every flight flew in still air and a standard atmosphere. Phase 6 makes the world
dynamic: weather that affects planning, flight and risk. Two requirements shape the design. The
world must stay deterministic and replayable (ADR 0005, ADR 0018, ADR 0020), and the planner's
estimate must still equal the outcome (ADR 0016). No live weather is used.

## Decision

### Weather is computed, not stored

The environment at a place and time is a **pure function of the world seed, the simulation tick
and the position**. It has no state, consumes no random stream and is not persisted.

- The planner and the engine call the same function. The planner evaluates the weather the flight
  will actually meet, at the times it will meet it, so estimate and outcome agree exactly for a
  stated departure time.
- The forecast is therefore exact. Forecast uncertainty is not modelled in this phase; agreement
  between planner and simulation was judged more valuable.
- Replay needs nothing extra: the same seed and tick give the same weather.

### The model

Smooth noise sampled on the unit sphere and in time, so there are no seams at the poles or the
antimeridian. Lattice values come from an integer hash of the seed. Only the operations ADR 0020
allows are used.

| Quantity       | How it is derived                                                                |
| -------------- | -------------------------------------------------------------------------------- |
| Pressure       | A large-scale field (systems about 1,000 km across, evolving over a day or two)  |
| Wind           | From the pressure gradient, so it circulates around lows; stronger with altitude |
| Moisture       | A second field                                                                   |
| Cloud, ceiling | From moisture and low pressure                                                   |
| Precipitation  | Where moisture is high and pressure low                                          |
| Visibility     | Falls with precipitation and low cloud                                           |
| Temperature    | Latitude, season, time of day, a noise term; a lapse rate with altitude          |
| Severity       | One 0 to 1 index from wind, precipitation and visibility                         |

Continuity in time and space follows from the noise being smooth: nothing is rolled per step.
Severe conditions sit in the tails of the noise and are uncommon by construction. The model aims
to be plausible, stable and useful. It is not meteorology.

### Effects on flight

The flight step's `Environment` input carries four things, and only these change the physics:

| Input         | Effect                                                            | Basis      |
| ------------- | ----------------------------------------------------------------- | ---------- |
| Tailwind      | Ground speed is airspeed plus the wind along the track            | Physical   |
| Crosswind     | The aircraft crabs; along-track airspeed is √(airspeed² − cross²) | Physical   |
| Temperature   | Warmer than standard: more cruise fuel and a lower climb rate     | Assumption |
| Precipitation | A small fuel penalty in proportion to intensity                   | Assumption |

Visibility and ceiling produce warnings and risk contributors only. Nothing fails because of
weather alone: risk explains, it does not decide (ADR 0017).

The planner also flies each plan in still air, so the interface can state what the weather costs
("headwind: +8 % time, +5 % fuel"), and a flight records its still-air estimate at launch so its
history can say the same afterwards.

### Model version

`SIM_MODEL_VERSION` becomes 4. A model-3 world keeps its state; its log is complete, for replay,
only from the upgrade.

## Consequences

- An estimate depends on the departure time. It is recomputed whenever it is shown and again at
  launch, and it says so.
- Weather costs computation per aircraft per step. It is integer hashing and a few interpolations;
  the display samples a coarse grid on its own cadence and never on the frame path.
- A later phase can add forecast uncertainty by perturbing what the planner is shown, without
  changing the field.
