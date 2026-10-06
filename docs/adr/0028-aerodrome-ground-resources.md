# 0028 — Aerodrome capability, ground resources and payload

- Status: Accepted
- Date: 2026-10-05

## Context

Phase 8B made the ground part of an aircraft's life take time
([ADR 0027](0027-ground-servicing.md)), but every aerodrome was the same, any number of aircraft
could be fuelled at once, and payload was still set at the instant of launch. Phase 8C makes an
aerodrome a facility with a capability and a finite number of things to service aircraft with.

What had to survive: one deterministic step, a world that reloads exactly and replays from its
seed and its log, fuel computed and never accumulated, one readiness rule, and no automatic
launch.

## Decision

### Capability comes from the aerodrome's sourced size class

The reference data classes every aerodrome as large, medium or small (OurAirports). That class
is copied onto the point the simulation holds for the aerodrome (`RoutePoint.size`), as its name
and position already are. The engine still reads no reference table.

`aerodromeCapability` turns the class into what the simulation needs: how many aircraft can be
fuelled at once, a factor on the fuel rate, how many can have payload handled at once, and a
payload rate. The class is reference data. Every figure derived from it is a simulation
assumption (`AERODROME_CAPABILITY`), stated in the interface as one, and is not a description of
any real aerodrome.

A point with no class (one copied before this phase, or a test fixture) is given the assumptions
of a medium aerodrome. A place that is not an aerodrome can service nothing.

### Two kinds of resource, and no stored occupancy

There are fuel points and handling points. Post-flight checks use neither.

Nothing records which aircraft holds which point. A point is held by an aircraft whose transfer
of that kind is running at that aerodrome; the queue for a kind is the aircraft waiting for it
there, in the order they began to wait (then by identifier). Occupancy and queue are therefore
functions of the aircraft's own service records. There is no lock to leave behind, and a saved
world cannot hold a queue that disagrees with its aircraft.

Each step, after services have advanced, free points are granted to the head of each queue. A
transfer begins at the tick the point is granted, and from there is exactly the transfer of
ADR 0027: a function of its start, its rate and the tick.

### One pipeline: checks, then fuel and payload side by side

A service is still one record. After the post-flight checks (if it began with a landing) it has
up to two tasks, fuel and payload, each with a target, the tick it began to wait, and its
transfer once it has a point. The two use different resources and run at the same time. The
aircraft is available when every task it has is done.

Payload is now loaded, or taken off, over simulated time like fuel: a time to position, then
the quantity at the aerodrome's payload rate. A launch requires the planned payload aboard, as
it requires the planned fuel, and departs with what is aboard. A delivered payload is still
unloaded at the moment its mission completes: that is the mission's outcome, not a ground task.

`serviceAircraft` carries a fuel target and, optionally, a payload target. `stopServicing` ends
running transfers where they are and withdraws anything still waiting.

### One forecast

`forecastGroundServices` works out, for all the aircraft at one aerodrome, when each task will
get its point, when it will finish, where each waiting aircraft stands in its queue and which
aircraft it is behind. It serves the queue in the order the engine will. The engine's refusals,
the readiness rule and every screen use it, so the time an aircraft is said to be ready is the
time it is, unless something further is asked of the aerodrome in between.

### Scheduled is not automatic

A mission's planned start is its scheduled launch time: when it is intended to leave. Nothing
launches by itself (ADR 0027 stands). If the scheduled time passes and the mission has not
launched, the world records `launchDelayed` once, with the reason the readiness rule gives, and
reports compare the scheduled time with the actual one.

There is no separate departure queue. The queue that exists is the one for ground resources,
and it is shown as what it is. Sequencing departures from a runway would be a new rule with
nothing yet to justify it.

### Releasing or cancelling a mission during preparation

Work for that mission that has not begun is withdrawn at once: a task still waiting for a point
leaves its queue, and fuel or payload that was to follow the checks is no longer asked for. A
transfer already running goes on to its end, as before. The log records the withdrawal.

### Simulation model 8

- A model-7 world loads and upgrades. A service under way keeps its fuel transfer and goes on to
  the same tick; it has no payload task.
- From the upgrade, payload must be aboard before launch, and fuel and payload wait for a point.
- Its log is complete for replay only from the upgrade, as with every earlier model change.

Migration 0010 adds one nullable column, `sim_place.size`: the operating area is the one place a
point is stored by column, and without it a reloaded world would have forgotten the class. The
service record and every other point are JSON already. No table is rebuilt.

## Consequences

- Two aircraft at an aerodrome with one fuel point are fuelled one after the other, and the
  second is told which aircraft it is behind and when its turn comes.
- An estimate still equals the outcome: the flight is evaluated with the fuel and payload aboard.
- Reports gain time spent waiting for a point, payload handling, services by aerodrome, and
  scheduled against actual launch.
- The capability figures are few and coarse on purpose. They are assumptions about a class of
  aerodrome, never facts about a named one.
- Points copied before this phase have no class and are treated as medium until an aircraft is
  based or lands somewhere the application has looked up since.
