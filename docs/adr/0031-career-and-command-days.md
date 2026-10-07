# 0031 — Career, command days and the start of the application

- Status: Accepted
- Date: 2026-10-07

## Context

V2 makes AEGIS a persistent career: the player takes command of UK military aviation in a world
that is already operating, and everything they do adds to one record. Before this decision the
application created a world the moment it started, ran it behind whatever screen was showing,
and kept no record that outlived a reporting period.

## Decision

### A career is state of the world, changed by logged commands

A career belongs to the world it is played in, so it lives in the simulation, is saved with it
and is re-derived by replay. Three commands:

- `beginCareer` marks the world as a career and turns on routine operations
  ([ADR 0030](0030-routine-operations.md)). Issued by the application.
- `takeCommand` opens Day 1. Issued by the player.
- `endCommandDay` closes the open day and opens the next at the same tick. Issued by the player.

There is never a gap between days, so nothing that happens can fall outside the record.

### A command day is not a calendar day and not a turn

The clock is continuous. A day ends when the commander ends it, and not before it has run one
simulated hour. Nothing forces it to end. Simulation time does not jump between days.

### The record is a fold over the log

Each day holds a set of named counters. They are advanced in one place: every entry the engine
writes to the log, command or event, is shown to the career, and a table says which counters it
moves. Nothing is counted that is not a logged occurrence in the simulation.

- **Open-ended.** Counters are a map from name to number. A later system contributes by emitting
  its events and adding rows to the table; the model, the table and the screens do not change
  shape.
- **Totals are sums.** A career total is the sum of that counter over every day. It is computed,
  not stored, so it cannot disagree with the days.
- **Readiness** is the share of aircraft that are available or flying, the definition reports
  already use for availability. Each day accumulates aircraft-seconds and ready-seconds, and
  keeps its lowest and highest.
- **Command time** is simulated time on command days.

What the model cannot yet support is not shown as a number. There are no decisions with
outcomes yet, so there is no "successful decisions" figure; orders given are counted by kind.

### A world is opened on request

The application starts at a main menu. Opening the database no longer creates a world.

- **Continue** opens the saved world. The clock does not advance until the player enters.
- **New career** creates a world. If one exists, the native core first writes a consistent copy
  of the database to the backups folder, and only then is the simulated world removed. Reference
  data is not touched.
- A new career is run forward from midnight to early morning before command is offered, so the
  commander arrives in a world with a past: flights in the air, aircraft on turnaround, missions
  already ended. Those hours are ordinary steps, in the log, and replay like any others.
- A world saved before V2 has no career. Continuing it offers command; the record starts there.

### The briefing is the world, read

The Daily Operational Brief is computed from the simulation's published state by pure functions.
It contains no figure that is not the state of the world at that tick.

### UK identity, fictional force

The player commands UK military aviation. Aircraft are real types the UK operates, with
fictional identities, at civil UK aerodromes; the laydown reproduces no real basing
([ADR 0011](0011-scenario-framing.md)). An aerodrome is counted as UK by its public ICAO
prefix (`EG`).

### Persistence

Migration 0011 adds `sim_career_day` (one row per day), three columns on `sim_world` and one on
`sim_mission`. No table is rebuilt.

## Consequences

- The menu, the briefing and the career record are new screens over existing state; the
  operational screens are unchanged.
- Ending a day produces a summary of that day beside the career totals before and after it.
- One database still holds one world. Starting a new career replaces it, after a backup.

## Not done

- No ranks, reputation, assessment or unlocks.
- No decision system, so no decision outcomes in the record.
- No save slots.
