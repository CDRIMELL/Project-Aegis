# 0022 — World events

- Status: Accepted
- Date: 2026-10-04

## Context

Weather makes the world vary continuously. The world also needs discrete happenings with
consequences: a closed aerodrome, a disrupted area, a logistics problem. They must be
deterministic, controlled in number, and must act on existing systems rather than sit in a feed.

## Decision

### One generic event

A `WorldEvent` has: id (`EVT-000001`), type, status, severity, created, start and end ticks, a
location and radius where relevant, the systems it affects, a description, and its source
(`generated` from the seeded stream, or `derived` from the weather field). An `Events` subsystem
in `@aegis/sim` owns them and is stepped after the fleet and missions.

### Lifecycle

`scheduled → active → resolved`, with `cancelled`. Every transition is logged (ADR 0018). An event
is announced before it starts, so the player can plan around it.

### Types and consequences

| Type                  | Consequence                                                                   |
| --------------------- | ----------------------------------------------------------------------------- |
| Aerodrome closure     | No departures from it; a plan that would arrive during it is blocked          |
| Navigation disruption | A warning and a risk contributor for routes through the area                  |
| Logistics disruption  | Creates an urgent logistics opportunity (ADR 0017)                            |
| Maintenance finding   | One grounded aircraft becomes due maintenance                                 |
| Severe weather        | Derived when the weather field is severe over the operating area; an advisory |

Adding a type is adding a member to the union and its consequence.

### Closures do not reach aircraft already airborne

A closure blocks a launch from the closed aerodrome, and blocks a launch whose estimated arrival
falls within a closure that is already known. An aircraft already airborne when a closure is
announced lands as planned, and the event is recorded on its mission. Anything else needs
diversion, which is not built (ADR 0017).

### Controlled generation

Generation is considered every two simulated hours from its own stream (`events.generation`). At
most three generated events are open at once. Places come from the operating area. Severe-weather
events are not rolled: they are read from the weather field.

### Missions

`evaluateMission` receives the events and the weather and adds constraints and risk contributors
with their reasons. An event that starts while a mission is flying is recorded in that mission's
history. No event fails a mission by itself.

### Operating area

The operating area is re-centred when the centre of the fleet's home aerodromes has moved 250 km
or more from where the area was chosen. The check runs only when a home changes. The replacement
is one logged system command; open offers are kept.

## Consequences

- The world changes without the player acting, and replays exactly: generated events come from a
  persisted stream, derived ones from the field.
- A plan that was valid can become blocked by an announced closure; the interface says why.
- Diversion, cascading events and event chains are deferred.
