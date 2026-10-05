# 0024 — Reports are derived from history

- Status: Accepted
- Date: 2026-10-05

## Context

Phase 7 adds reporting: what happened in a period, how the fleet was used, what it burned, what
needs maintenance, what the world's events affected. Everything needed is already recorded.
Finished flights, missions and events stay in their tables for ever (only the in-memory view is
limited to recent history), and the command and event log (ADR 0018) is append-only and complete.

The risk is a second source of truth: counters and summary tables that are maintained beside the
world and can drift from it.

## Decision

### Nothing is stored for reports

A report is computed on demand from `sim_flight`, `sim_mission`, `sim_event` and `sim_log`, and
from the live view for the current picture. There are no counters, no summary tables and no
reporting state in the simulation. The engine does not know reports exist.

- Queries select the rows that belong to the period; pure functions in
  `packages/domain/src/report/` turn them into summaries. The functions take rows and a period and
  return values, so they are tested without a database.
- Results are held in memory, keyed by the period and the checkpoint sequence number. A new
  checkpoint makes a new key; nothing is invalidated by hand.
- A report reads the last checkpoint, which is at most a couple of seconds behind the running
  world. It says which simulation time it is as of.

An index, or a stored summary, is added only when a measurement shows it is needed.

### Periods are simulation time

A period is a half-open range of ticks, `[from, to)`. The named periods (today, the last 24
hours, 7 days, 30 days) are resolved from the simulation clock; "today" is the simulated UTC day.
Wall-clock time is never used.

### One attribution rule

A flight, a mission or a maintenance visit belongs to the period in which it **finished**, with
the values recorded when it finished. Nothing is split across periods, so periods never
double-count and totals over adjacent periods add up. What is still in progress is shown apart
and counted in no total.

An event belongs to a period if it was open at any moment in it, because an event's effect is
its duration.

### History is what was recorded

Reports use the figures stored with the flight or mission at the time: fuel at departure and on
landing, distance flown, the estimate made at launch. They never re-evaluate a past flight
against the aircraft's present performance model or present reference data.

### Availability and utilisation

Each aircraft's status over time is rebuilt from the log (launch, landing, maintenance due,
maintenance started and completed, a forced landing). For a period:

- **availability** is the time the aircraft was not due maintenance, in maintenance or
  unserviceable, over the time it was owned in the period;
- **utilisation** is the time it was airborne, over the same.

These are AEGIS simulation measures and are labelled as such. A world upgraded from before the
log existed has no status history before the upgrade; that part of a period is reported as not
recorded, not estimated.

### Risk at acceptance and at launch

A mission keeps two assessments, each the planner's figures and the risk index with its
contributors:

- `acceptance`: what the operator accepted. Recorded at acceptance and never changed. Cleared
  only if the mission is released before launch, because it is then no longer accepted.
- `assessment`: the figures for the departure. Equal to `acceptance` until launch, evaluated
  again at launch for the actual departure time (ADR 0021), and never changed after.

Both use the one risk model (ADR 0017). A mission accepted before this decision has no
`acceptance`; reports show it as not recorded.

This is the only change to the simulation in this phase. Accepting a mission now records more
state, so the simulation model becomes 5, and a world saved under model 4 replays only from its
upgrade, as before (ADR 0018).

## Consequences

- A report cannot disagree with the world: it holds nothing of its own.
- The same world gives the same report, in any session, before and after a restart.
- Cost grows with the history in the period. At the volumes a single-player world produces this
  is a few milliseconds; the test suite measures it on a large synthetic history.
- Splitting a long flight across two days is not possible. A flight that lands just after
  midnight counts wholly in the new day.
- No monetary cost is reported, because the simulation has no prices. Fuel is reported in
  kilograms.
