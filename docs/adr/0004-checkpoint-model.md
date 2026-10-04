# 0004 — Whole-state checkpoints in a single transaction

- Status: Accepted
- Date: 2026-10-04

## Context

The world must survive restarts and unexpected termination. The handover suggests saving critical
transitions promptly and high-frequency telemetry at intervals. Done naively, that leaves the
database holding an event from one instant beside aircraft state from an earlier one.

## Decision

- While running, the in-memory world inside the worker is authoritative. The database is its durable
  image.
- A **checkpoint** writes the clock, every RNG stream state and all changed world state in **one**
  transaction. The database therefore always describes a single simulation instant.
- Checkpoints are taken:
  - on a real-time interval while the world is dirty (default 2 s),
  - immediately on any critical transition (pause, resume, speed change today; mission and event
    transitions later),
  - on window close.
- Snapshots are captured synchronously at a step boundary. Writes are serialised: if a write is in
  flight, the newest snapshot waits and older waiting snapshots are discarded.
- Each checkpoint carries a monotonically increasing sequence number and the wall-clock time it was
  taken.

## Consequences

- After a crash the world resumes from the last checkpoint: at most one interval of simulated
  progress is lost, and what remains is internally consistent.
- "Save this event now" is expressed as "checkpoint now", never as a lone row write.
- Checkpoint cost grows with the amount of changed state. Later phases track dirty entities so a
  checkpoint writes only what changed; the transaction rule stays the same.
