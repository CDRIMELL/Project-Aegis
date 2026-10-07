# 0030 — Routine operations: a world that flies without being told to

- Status: Accepted
- Date: 2026-10-07

## Context

Through Phase 8D nothing flew unless the player launched it. A new world was a few parked
aircraft and, now and then, an offer. V2 turns that round: the world is already operating when
the player takes command, and the player's work is to decide what matters.

A briefing that says aircraft are flying has to be true. So the first thing V2 needs is the
smallest system that makes it true: routine sorties that the world tasks, prepares and launches
itself.

What had to survive: one deterministic step, a world that reloads exactly and replays from its
seed and its log, one mission framework, finite ground resources, and every existing world and
scenario behaving as it did.

## Decision

### Routine operations are part of a career, and off everywhere else

A world has routine operations only once a career has begun in it (`beginCareer`,
[ADR 0031](0031-career-and-command-days.md)). A world without a career, which is every world
saved before this decision and every existing test and scenario, is unchanged: nothing is tasked
and nothing launches by itself.

### The world tasks ordinary missions

Every fifteen simulated minutes the world considers tasking one aircraft. A routine task is an
ordinary mission built from the existing templates by the existing `defaultConfiguration`, and
judged by the existing objectives. It is marked `routine`, and otherwise is not special: it is
planned, accepted, prepared at the aerodrome's finite points, and flown by the same code as a
mission the player creates.

- **Which aircraft.** One that is available, on the ground, able to fly and not committed.
- **A reserve is kept.** Of each category the world leaves at least a third untasked, and at
  least one where the fleet has two or more. The reserve is what the commander has to respond
  with.
- **What it is asked to do.** At its base: a training sortie, a patrol, or a delivery to an
  aerodrome of the operating area, as its category suits. Away from its base: to come home,
  carrying freight if it is a type that does.
- **Only what can be flown.** The task is evaluated like any plan. One the planner blocks is not
  created.

### The world launches its own routine missions

"Nothing launches automatically" (ADR 0028) was a rule about the player's missions, and still
is: a scheduled launch time on a mission the player owns stays advisory. A routine mission is
the world's own, and the world launches it at the step its aircraft is ready, by the same
readiness rule that would refuse the player. One that still cannot leave four hours after it was
tasked is stood down and its aircraft freed.

### Logged as what the world did, so replay regenerates it

Tasking and launching are not commands. They happen inside the step, drawn from a named random
stream (`missions.routine`), and are recorded as events: `routineTasked`, `missionLaunched`,
`routineStoodDown`. A replay re-derives them from the seed, exactly as it re-derives weather
events and offers. `missionLaunched` joins the entries the status history reads, so reports
count a routine flight like any other.

### The commander keeps every existing control

A routine mission can be released, cancelled, launched early, rerouted, diverted, held or
aborted with the commands that already exist. Cancelling one frees its aircraft for something
else, and leaves that task unflown: the first, plain form of a consequence.

### What is not decided for the player

The world does not start maintenance. An aircraft that falls due waits for the commander, as
before. Offers are still offers.

## Consequences

- A career world has flights in the air, aircraft being prepared and turned round, and queues at
  busy aerodromes, with no input.
- Aircraft wear with use, so maintenance falls due without the player having flown anything.
  Left alone, availability falls. That is intended.
- Routine pacing and the reserve are simulation assumptions (`ROUTINE`), stated as such.
- Simulation model 10. A model-9 world loads and upgrades with nothing in it changed and routine
  operations off.

## Not done

- No demand model: routine tasks are drawn, not derived from requirements.
- No decisions, incidents with options, or consequences beyond what the existing systems
  already produce.
- The world does not manage maintenance, rebasing or crews.
