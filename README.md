# AEGIS

**Aerospace Operations & Simulation Platform.** A local-first desktop application: professional
aerospace operations software with a persistent, deterministic simulation underneath it.

AEGIS is a software engineering and simulation project. Reference data is real and sourced; the
operator, fleet and everything that happens are simulated. It is not an operational planning tool.

## Status

Phase 2 of 10 complete.

- **Foundation:** the application launches, runs a deterministic simulation clock at 1x to 100x,
  checkpoints it transactionally to SQLite and resumes the exact same world after a restart.
- **Reference data:** real countries, aerodromes, runways, cities and aircraft types are imported
  with provenance by an idempotent, reproducible pipeline.

There is no map, fleet or mission system yet.

## Requirements

- Windows 10 or 11 with the WebView2 runtime (included in Windows 11)
- Node.js 24 or later
- Rust (stable, MSVC toolchain) and the Visual Studio C++ build tools

No account, API key, paid service or network connection is needed to build or run.

## Getting started

```sh
npm install
npm run dev          # run the desktop app with hot reload
npm run ci           # format, lint, type-check and all tests (TypeScript and Rust)
npm run build        # release executable and installer
npm run verify:world # replay the saved world from its seed and confirm it matches

npm run data:fetch   # download the public reference datasets (once; needs a connection)
npm run data:import  # import reference data into the application's database
```

The world is stored in `%APPDATA%\dev.aegis.desktop\aegis.db`. Delete that file to start a new
world.

## Layout

```
apps/desktop        Tauri shell, simulation worker host, screens
  src-tauri         Rust core: SQLite ownership, migrations, session gate
packages/domain     Pure value types and rules
packages/sim        Simulation engine and runner
packages/db         Drizzle schema, migrations, persistence
packages/ingest     Reference-data pipeline: parse, validate, load
packages/ui         Design system: tokens and components
data                Curated reference files and the lock that pins downloaded sources
docs                Architecture, design system, reference data, decision records
```

## Documentation

- [Architecture](docs/architecture.md)
- [Design system](docs/design-system.md)
- [Reference data](docs/reference-data.md)
- [Architecture decision records](docs/adr/README.md)
