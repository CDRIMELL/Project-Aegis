# 0020 — Deterministic mathematics

- Status: Accepted
- Date: 2026-10-04

## Context

The simulation must produce the same world from the same seed and the same commands (ADR 0005,
ADR 0006). The command log (ADR 0018) made it possible to check that for a whole world: replay the
log in a fresh engine and compare.

The first time a world created by the running application was replayed by the verification tool,
it did not match. One distance differed in its last binary digit.

The cause is the language, not the code. JavaScript guarantees the exact result of addition,
subtraction, multiplication, division and square root. It does **not** guarantee the exact result
of `Math.sin`, `Math.cos`, `Math.tan`, `Math.asin`, `Math.atan2` or `Math.log`: an engine may
return either neighbouring value. Measured on this machine, all six differ between Node (V8 13.6)
and the WebView2 engine the application runs in (Chromium 154). `Math.sqrt` and `Math.hypot` agree.

That matters beyond the tool. WebView2 updates itself. A world would have been reproducible only
until the next engine update, and "the same world from the same seed" would have been true on one
machine on one day.

## Decision

- The simulation core (`@aegis/domain`, `@aegis/sim`) does not call engine-dependent `Math`
  functions. It uses `packages/domain/src/math.ts`, which provides `sin`, `cos`, `tan`, `asin`,
  `acos`, `atan`, `atan2`, `ln` and `hypot` built **only** from the operations the language
  guarantees: reduce the argument with exact steps, then sum a short power series.
- These functions are accurate to about one part in 10^15. They are not meant to equal `Math.*`
  bit for bit. They are meant to equal themselves on every engine.
- Text that is stored with the world (objective remarks, risk explanations, objective labels) does
  not use locale formatting, which depends on the engine's locale data. `groupThousands` formats
  whole numbers. `toFixed` is fully specified by the language and stays.
- ESLint enforces both in the simulation core: the engine-dependent `Math` functions, the `**`
  operator and `toLocaleString` are errors there. Tests may call `Math.*` to check accuracy.
- A golden test records the exact bits of 100,000 results of each function and of 20,000 geodesy
  calculations. The recorded values were confirmed identical under Node and under WebView2.

The display layer (map drawing, formatting in screens) is not simulation state and may use `Math`
and `Intl` freely.

## Consequences

- A world replays to the bit under any conforming engine. `npm run verify:world` can therefore
  check a world written by the application.
- Positions and distances differ from model 2 by at most a few parts in 10^16. A saved world is
  unaffected: its state is stored, not recomputed. Simulation model 3 is the first to use these
  functions, so no world mixes the two.
- The series are a little slower than the engine's functions. The simulation makes a handful of
  such calls per aircraft per step; the cost is not measurable.
- Anything added to the simulation core must stay within the guaranteed operations. The lint rule
  says so at the point of use.
