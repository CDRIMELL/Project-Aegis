# 0006 — Seeded, named, persisted RNG streams

- Status: Accepted
- Date: 2026-10-04

## Context

The event engine, weather and traffic will all be probabilistic. Tests must be able to reproduce a
run exactly, and a reloaded world must continue with the same random sequence it would have produced
had it never been closed.

## Decision

- The generator is `xoshiro128**`: 128 bits of state, 32-bit integer arithmetic that JavaScript
  performs exactly, and good statistical quality for simulation use. It is not cryptographic and is
  never used for security purposes.
- A world has one seed. Each subsystem draws from its own **named stream**, derived by hashing
  `(world seed, stream name)`. Adding a new subsystem or changing how often one subsystem draws does
  not disturb the sequences of the others.
- Every stream's state is part of the world snapshot and is written in every checkpoint (ADR 0004).
- `Math.random` and `Date.now` are banned in `@aegis/domain` and `@aegis/sim` by lint rule.

## Consequences

- Same seed and same commands give the same world, on any machine.
- Tests can force rare scenarios by choosing seeds or by injecting stream state.
- Stream names are persisted identifiers. Renaming one changes saved-world behaviour and must be
  treated as a simulation model change.
