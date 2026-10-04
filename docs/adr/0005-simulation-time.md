# 0005 — Fixed timestep; resume from last persisted instant

- Status: Accepted
- Date: 2026-10-04

## Context

The world must behave identically at every speed multiplier and at every UI frame rate, and V1 must
resume where it stopped when the application reopens.

## Decision

- Simulation time advances in fixed steps of one simulated second (`SIM_STEP_MS = 1000`).
- The speed multiplier (1, 2, 5, 10, 50, 100) only changes how many steps run per real second. Rules
  never see the multiplier.
- The runner converts measured real elapsed time into owed simulated time and runs whole steps. Real
  elapsed time per advance is capped (default 1 s) so a stalled or throttled host cannot trigger an
  unbounded burst.
- Sub-step remainder is host timing state, not world state. It is not persisted.
- On launch the world is restored from the last checkpoint and continues from that instant.
  Simulated time does not pass while the application is closed.

## Path to offline catch-up

Nothing in the engine reads the wall clock. `SimulationEngine.runSteps(n)` is the only way time
moves, and every checkpoint records the wall-clock time it was taken. A later catch-up feature is
therefore: compute the steps owed since the last checkpoint, run them in bounded chunks, checkpoint.
No engine redesign is needed.

## Consequences

- A run at 100x produces the same world as the same number of steps at 1x.
- Rules that need a rate must express it per unit of simulated time (for example a hazard rate per
  simulated hour), never per tick of the host timer.
- Finer-grained motion on screen is the renderer's job: it interpolates between published states.
