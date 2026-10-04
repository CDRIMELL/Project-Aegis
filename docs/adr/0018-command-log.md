# 0018 — Command and event log

- Status: Accepted
- Date: 2026-10-04

## Context

Until now a saved world recorded its state but not how it got there. Once the player had acted,
the world could not be re-derived from its seed (ADR 0016), and there was no history to show,
audit or debug from. Missions add many more meaningful actions.

## Decision

One append-only table, `sim_log`, written by the engine.

### Two kinds of entry

- **command**: an action that changed the world, recorded with its complete payload (the plan, the
  aircraft order, the mission edit). Actor `player`, or `system` for commands the application
  issues itself (starter fleet, operating area, model migration).
- **event**: something the world did as a result of stepping: a flight landed, an objective
  completed, a mission completed or failed, maintenance finished, an opportunity was generated or
  expired. Actor `world`.

Each entry has: `seq` (1, 2, 3, ... with no gaps), `tick`, `kind`, `type`, `actor`, the mission,
aircraft and flight ids it concerns (each nullable), and a JSON `payload`.

### Rules

- **The engine assigns the sequence**, in the order things happen within a step and across steps.
  No wall-clock time is recorded in the log. The same seed and commands give the same log.
- **Atomic with state.** Entries not yet on disk travel in the world snapshot and are inserted in
  the same checkpoint transaction as the state they describe. A crash loses both or neither.
  Inserts are idempotent on `seq`, so a retried checkpoint cannot duplicate an entry.
- **Append-only.** The store never updates or deletes a log row.
- **Not logged:** rejected commands (the world is unchanged), commands that had no effect, and
  pause, resume and speed changes, which alter pacing but not what happens at any tick.
- **Drafts are not logged.** Editing an unsaved flight-plan draft is interface state. Saving a
  route to a mission is a command and is logged with the whole route.
- The engine keeps a short tail of recent entries in memory for display; the database holds the
  whole log.

### Replay

Because commands carry complete payloads, seed plus log is enough to re-derive a world.
`tools/verify-world.ts` replays the log into a fresh engine and compares the complete state. That
is verification, not a replay feature: there is no replay interface.

A world created before the log existed has history the log does not cover. `sim_world` records the
tick the log is complete from; a world whose log does not start at tick 0 can be checked for
continuity (ADR 0005) but not replayed.

## Consequences

- Mission history, aircraft history and the audit view of phase 8 read from one source.
- Command payloads make the log larger than a bare audit trail; entries are per action, not per
  step, so growth is modest.
- Any new command or subsystem event must be logged, or replay verification fails. The replay
  check in the test suite enforces this.
