# 0026 — In-flight operational control

- Status: Accepted
- Date: 2026-10-05

## Context

Until now an operator planned a flight, launched it and watched it. Once airborne nothing could be
changed, and the world's events did not touch an aircraft in the air: a destination that closed
still accepted it (ADR 0022). Phase 8A lets the operator act on a flight in progress, and makes
closures matter to it.

Three properties of the existing design had to survive: one route system, one flight step shared
by the planner and the simulation so that an estimate equals the outcome, and a world that can be
re-derived from its seed and its log.

## Decision

### One primitive: a flight revision

`reviseFlight` replaces the rest of an airborne flight's route. Its `intent` (`reroute`, `divert`,
`return`) is recorded and shown; the mechanics are the same for all three.

- The command carries what the operator chose: the intent and the new remaining points, ending at
  an aerodrome. It does not carry where the route changes. That is the aircraft's position at the
  tick the command is applied, which the simulation derives, so replay reproduces it exactly.
- A revised flight still has one `FlightPlan`: the points already passed, a waypoint at the
  present position, and the new remainder. The same geometry, flight step, weather sampling and
  map read it as they read any plan. There is no second route representation.
- The flown prefix is never rewritten. Distance flown is re-measured along the revised route, so
  the aircraft is exactly where it was.
- The flight keeps the plan it was launched with (`plannedPlan`) and a list of `revisions`, each
  with its tick, intent, position, fuel aboard and the remainder it replaced.
- The mission's plan is not changed. It is what was intended; the flight is what was flown.
- A revision to the route already being flown has no effect and is not logged.

### The same checks as planning

`evaluateRevision` checks a proposed remainder with the planner's severities and estimates it by
flying it from the flight's present state with the simulation's own step. `projectFlight` does the
same for the flight as it stands. The interface previews with these; the engine validates with
`evaluateRevision` before changing anything.

Blocked: during the take-off roll; a route that does not end at an aerodrome; a destination the
fuel will not reach; a destination nearer than a descent from the present altitude needs (the
model descends along the route, and a waypoint that lengthens the route makes it possible).
Warned and allowed: landing below reserve, a disrupted area on the route, a destination that is
closed on arrival.

A revision made in the descent ends the descent. Whether the aircraft then climbs, cruises or
descends is decided by the ordinary step, and a climb costs what a climb costs.

### Holding

An aircraft that is holding covers no ground and keeps its altitude. It flies through the air at
75 % of cruise speed (an assumption, stated with the others) and burns fuel for that distance at
the ordinary rate. Time passes normally.

- `holdFlight` and `resumeFlight` are operator commands, valid in the climb and the cruise.
- Any hold ends by itself when fuel is down to reserve.
- A revision ends a hold.

### A destination closed on arrival

This replaces the rule of ADR 0022 that an airborne aircraft is always accepted.

- At the top of its descent, an aircraft whose destination is closed, or will be before the
  descent could end, holds there instead of descending.
- The hold ends when the aerodrome reopens, and the aircraft lands.
- The operator may divert it at any time. `resumeFlight` is refused: it is not the operator's hold.
- If fuel falls to reserve while the aerodrome is still closed, the aircraft lands anyway. The
  landing is recorded as made during a closure, and the aircraft is due maintenance before it
  flies again. Nothing fails, and nothing is decided for the operator.
- An aircraft already descending when a closure begins is committed and lands.

The hold is flown at the top of descent, short of the destination, and not overhead: the flight
model descends along the route and has no way down from overhead.

The rule lives in the shared step (`holdDecision`), so the planner's projection of an airborne
flight includes any hold exactly. Before launch nothing changes: a plan that would arrive during a
known closure is still refused.

### Aborting a mission

A mission in flight may be `aborted`. This is distinct from `cancelled`, which is only possible
before launch, and from `failed`, which the objectives decide.

- `abortMission` names where the flight is to land: on to its destination, back to its origin, or
  to another aerodrome. There is no default.
- The mission ends at once. Completed objectives stay complete. Pending objectives fail with the
  remark "Mission aborted."
- The flight goes on as an ordinary flight. If the landing needs a change of route, it is made as
  part of the same command; if that route cannot be flown, the whole command is refused.

### Where the aircraft landed

Objectives about the destination (`complete_flight`, `deliver_payload`, `arrive_by`) are met only
by landing at the destination the mission was planned to. Landing elsewhere fails them with
"Landed at X, not at Y." `return_to_base` is judged by where the aircraft landed. A diverted
mission is not aborted; it is judged on landing, by its objectives, as any mission is.

### Technical caution

One new event type, `technical_caution`, drawn from the existing seeded event stream when an
aircraft is in flight.

- The flight is not changed. The aircraft may go on.
- While it does, it wears faster: 2 % of condition per hour flown with the caution showing, on
  top of ordinary wear.
- It is due maintenance when it lands, wherever that is.
- The event ends when the aircraft has been maintained.

The decision it asks for is whether to go on or land early. It is not a failure model.

### Events record when they ended

When an event is resolved its `endTick` becomes the tick it was resolved on. A maintenance finding
and a technical caution are created with no end of their own. Migration 0008 gives events resolved
before it their real end from the log.

### Simulation model 6

- A model-5 world loads and upgrades. Its flights have no revisions and are as launched.
- Its log is complete for replay only from the upgrade, as with every earlier model change.
- From the upgrade tick the closure rule applies to every flight, including one already airborne.

## Consequences

- An estimate still equals the outcome: after a revision, during a hold, and for a destination
  closed on arrival. The test suite asserts each exactly.
- A flight that has been revised or has held has no "same plan in still air" to be compared with,
  so it records no weather cost.
- A destination nearer than the descent distance cannot be diverted to directly.
- A closure announced after the descent has begun does not stop the landing.
- Fuel is still loaded instantly at launch. Turnaround and timed refuelling are Phase 8B; a
  diverted aircraft is ready to fly again as soon as it has landed, unless it is due maintenance.
- Migration 0008 rebuilds two tables to admit the new status and event type. It is written to run
  inside one transaction with foreign keys on: the links from flights to missions are set aside
  and restored around the rebuild.
