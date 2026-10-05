# 0027 — Turnaround, refuelling and readiness

- Status: Accepted
- Date: 2026-10-05

## Context

Until now an aircraft that landed was available in the same step, and a launch set the fuel aboard
to whatever the plan asked for. Fuel appeared, and disappeared, at no cost in time. Phase 8A
deferred this deliberately ([ADR 0026](0026-in-flight-control.md)).

Phase 8B makes the ground part of an aircraft's life take simulated time. The properties that had
to survive are the usual ones: one deterministic step, a world that reloads exactly and replays
from its seed and its log, and an estimate that equals the outcome.

## Decision

### One state, one record

There is one new aircraft status, `servicing`: on the ground, not available for launch, and due
to become available by itself. While it lasts the aircraft carries one `service` record:

- `reason`: `turnaround` (it has just landed) or `preparation` (it is being made ready to fly);
- `stage`: `checks`, then `refuelling`;
- when the checks end, the fuel to bring it to (if any), and the fuel transfer under way (if any).

Nothing else describes ground state. `available`, `servicing`, `maintenance_due`,
`in_maintenance`, `unserviceable` and `in_flight` remain mutually exclusive, and the record
exists exactly when the status is `servicing`. A saved world that says otherwise is refused when
it is loaded.

Whether an aircraft is committed to a mission is not an aircraft state. It stays where it was:
the accepted or active mission that names the aircraft.

### Fuel is computed, not accumulated

A fuel transfer records where it started, what it started from, its target, its rate and the
tick it completes. The fuel aboard at any tick is a function of those and the tick. The step
writes that figure to the aircraft; it never adds an increment to the last one. So a world saved
part-way through a transfer continues to the same completion tick and the same fuel, at any
speed, and the target is reached exactly.

Progress shown in the interface is derived the same way. Nothing is logged per step.

### Times are simulation assumptions

`GROUND_SERVICE` in `packages/domain/src/ground/service.ts` holds them, each with a statement
shown in the interface. They are not reference data and are not presented as such.

- **Post-flight checks:** a base time plus a little for each hour just flown, up to a limit.
- **Refuelling:** a time to connect, then the quantity divided by a rate. The rate fills the
  type's tanks from empty in a fixed time, within a lower and an upper bound, so more fuel takes
  longer and a larger aircraft is served by a faster supply.
- Taking fuel off is the same transfer in the other direction, at the same rate.

Aerodromes do not differ in what they can supply. That is a later refinement, and the rate is
the one place it would enter.

### Landing begins a turnaround

An aircraft that lands healthy becomes `servicing` for its post-flight checks, then `available`.
A turnaround does not refuel by itself: fuel is loaded for a flight, when one is decided.

An aircraft that lands due maintenance (hours, condition, a technical caution, a landing during a
closure) becomes `maintenance_due` exactly as before and gets no turnaround. Maintenance is
unchanged, and returns the aircraft `available` with the fuel it had.

### A launch flies the fuel that is aboard

A launch no longer sets the fuel. It requires the fuel aboard to be the fuel the plan asks for,
and the flight departs with what is aboard. If the two differ the launch is refused, and says by
how much and how long the difference takes to load.

- `serviceAircraft` brings an aircraft's fuel to a target, over time. It replaces `setLoad`.
  Given to an aircraft already being serviced, it sets or changes the target.
- `stopServicing` ends a fuel transfer where it is. Post-flight checks cannot be skipped.
- Accepting a mission commits its aircraft, as before, and now also begins loading the mission's
  fuel. If the aircraft is still in its post-flight checks, the fuel follows them.
- Launch remains the operator's action. Nothing launches by itself, and a mission that is not
  ready is not rescheduled: it waits, and says why.

Payload is still set at launch. Loading it takes no time; that is not modelled.

### One readiness rule

`launchReadiness` in the domain decides whether an aircraft can launch a given load from a given
place now, and why not. The fleet's launch calls it to refuse; the planner, the mission page and
the fleet screens call it to explain. No component decides readiness for itself.

### Commands may report what they caused

A command that starts or ends a service says so in the log (`servicingStarted`,
`refuellingStarted`, `refuellingCompleted`, `servicingCompleted`), the same events the step
writes when a stage changes by itself. The engine records them after the command's own entry,
and discards them if the command is refused. Replay reproduces them as it reproduces everything
else.

### Simulation model 7

- A model-6 world loads and upgrades. Its aircraft are as they were: none is being serviced.
- From the upgrade tick, a landing begins a turnaround and a launch needs its fuel aboard. An
  accepted mission whose aircraft does not hold the mission's fuel is not launchable until the
  aircraft is prepared, which the mission page offers.
- Its log is complete for replay only from the upgrade, as with every earlier model change.

Migration 0009 adds one nullable column, `sim_aircraft.service`. No table is rebuilt.

## Consequences

- An estimate still equals the outcome: the flight is evaluated with the fuel aboard, which is
  the fuel planned.
- A newly acquired aircraft has full tanks. Its first flight usually needs fuel taken off, which
  takes minutes of simulated time.
- Reports gain time spent servicing, turnarounds and their durations, fuel loaded and removed,
  and how long each mission's aircraft took to prepare. They are derived from the log, like the
  rest.
- There is no queue of departures and no automatic launch. "Delayed by preparation" is reported
  as what can be measured: the missions that had to be prepared, and for how long.
- Maintenance does not refuel, and a turnaround does not wait for a fuel bowser, a crew or a
  stand. Those belong to a later phase if they are wanted.
