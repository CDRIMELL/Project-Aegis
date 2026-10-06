# 0029 — Aerodrome size classes for existing worlds, timed unloading and service reporting

- Status: Accepted
- Date: 2026-10-06

## Context

Phase 8C ([ADR 0028](0028-aerodrome-ground-resources.md)) left three things unfinished, and said
so:

- An aerodrome copied into a world before the size class was kept had none, and was treated as
  medium whatever the reference data said of it.
- A payload was loaded over time, but a delivered payload left the aircraft at the instant its
  mission completed.
- A finished ground service was recorded, but could not be exported, and nothing set out what
  had happened at one aerodrome.

It also left readiness explained by one rule for the aircraft, with the plan's own blocking
constraints decided separately by each screen that offered a launch.

This phase completes those. It adds no new subsystem: no departure queue, no runway or traffic
model, no automatic launch.

## Decision

### An existing world is given the size classes the reference data holds

The engine reads no reference table, and that does not change. The application looks up the
aerodromes a world holds without a class in the packaged reference data, by their reference
identifier, and sends what it finds as one system command, `classifyAerodromes`.

- **It fills in; it never replaces.** A point that has a class keeps it. A point is classed only
  when it is an aerodrome, has a reference identifier, and has no class.
- **Nothing is invented.** An aerodrome the reference data does not hold, or holds as something
  other than a large, medium or small airport, is left without a class and goes on being treated
  as medium. Nothing is inferred from a name, a position or a runway.
- **Everywhere the world holds the aerodrome**: an aircraft's base and location, the operating
  area, the plans of flights in the air, and the plans and destinations of missions not yet
  finished. Finished records are history and are not rewritten.
- **Logged and replayable.** The command is in the log with the actor `system` and the classes it
  carried, so a replay does not need the reference data. A command that would change nothing is
  not logged.
- **Deterministic.** The lookup is by identifier against data shipped with the application, and
  the same world and the same pack give the same command.

The class is real reference data (OurAirports). The capability derived from it is still a
simulation assumption, and the interface still says so.

A consequence the operator will see: an aerodrome the reference data classes as large gains a
second fuel and handling point from the tick of the command, and a small one is fuelled and
handled more slowly. A transfer already running keeps the rate and the end it was given.

### A delivered payload is taken off over time

When a delivery lands at its destination the mission completes, as before: the payload has
arrived. It is now still aboard. The turnaround that every landing begins is given a payload
task with a target of nothing aboard, so the unloading follows the post-flight checks, takes its
turn at the aerodrome's payload handling, and takes the time any payload transfer takes.

**The availability rule: an aircraft is available when its turnaround is done, and the
turnaround of a delivery is its checks and then its unloading.** Until then it is `servicing`,
cannot be launched, and every screen gives the tick it will be available.

- It uses what Phase 8C built: the same task, the same queue, the same forecast and the same
  computed transfer. No new state and no new stage.
- The mission records `payloadUnloading` when it completes, with the quantity and the place.
- An aircraft that lands due maintenance is not turned round, as before, so nothing unloads it.
  The payload stays aboard and comes off when the aircraft is next prepared: a launch needs
  exactly the planned payload aboard, so preparation takes off what should not be there.
- A flight that does not deliver (a diversion, a return to base, an abort) leaves its payload
  aboard, as before.
- The next mission accepted for an aircraft still unloading changes the payload task's target:
  what is aboard is brought to what the next flight carries, in one transfer.

### Services are exported, and each aerodrome has a report

The reports gain one table, `services`, in the existing export architecture
([ADR 0025](0025-report-export.md)): one row for each service finished in the period, in the
order the log holds them. It gives when and where, the aircraft and mission, the kind of
service, the resources used, the time on checks, in a queue, on fuel and on payload, what was
asked for and what was moved, and whether the service ended short of what was asked.
`servicingCompleted` now carries the fuel and payload asked for, and whether the operator
stopped it, so the export does not guess.

The Reports screen gains a section, Aerodromes and services. It lists each aerodrome that
serviced an aircraft, or that a flight left or reached, in the period. Choosing one shows its
identity, its capability (marked as a simulation assumption), what it is doing now, and its
services, fuel, payload and flights for the period. Like every report it is derived from what
the world recorded, and nothing is stored for it. The choice of aerodrome is a filter, and the
export is what the screen shows.

### One answer to "can it launch", including the plan

`launchState` in the application now takes the plan's blocking constraints with the aircraft's
readiness and returns one answer, `launchable`, one ordered list of reasons and one checklist.
The planner and the mission page both use it, and neither decides anything itself. The engine
still refuses a launch with `launchReadiness` and the plan's evaluation; a test holds the first
reason on the screen to the engine's own refusal, word for word, for every way a launch can be
blocked.

### Simulation model 9, and no migration

- A model-8 world loads and upgrades with nothing in it changed.
- From the upgrade, a delivery is unloaded over time. A service under way is untouched.
- Its log is complete for replay only from the upgrade, as with every earlier model change.

`verify-world` now applies the same rule the engine does: a world saved by an earlier model and not
yet opened by this build is reported as not replayable, where it used to be replayed under the
new rules and reported, wrongly, as a mismatch.

No table changes: the size class already has its column and its JSON, and the unloading is a
task in the service record that already exists.

## Consequences

- An aircraft is available later after a delivery than it was: by the time to position the
  handling equipment and move the payload, and by any wait for the handling point.
- Two deliveries landing together at an aerodrome with one handling point are unloaded one after
  the other.
- An aircraft that delivers and lands due maintenance keeps its payload aboard through
  maintenance. This is stated, not hidden: the aircraft panel shows the payload aboard.
- An aerodrome the reference data does not class stays medium. That is the fallback, not a
  finding about the aerodrome.
- The services table is the first export whose rows are ground work. It has no cost columns:
  the simulation has no prices.

## Not done

- No departure queue, runway occupancy or traffic sequencing.
- No capability beyond the size class: no per-aerodrome fuel stock, opening hours or equipment.
- Unloading at an aerodrome where the aircraft is not turned round is not modelled separately.
