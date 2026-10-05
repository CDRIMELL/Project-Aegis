# AEGIS

**Aerospace Operations & Simulation Platform.** A local-first desktop application: professional
aerospace operations software with a persistent, deterministic simulation underneath it.

AEGIS is a software engineering and simulation project. Reference data is real and sourced; the
operator, fleet and everything that happens are simulated. It is not an operational planning tool.

## Status

Phase 7 of 10 complete.

- **Foundation:** the application launches, runs a deterministic simulation clock at 1x to 100x,
  checkpoints it transactionally to SQLite and resumes the exact same world after a restart.
- **Reference data:** real countries, aerodromes, runways, cities and aircraft types, with
  provenance, from an idempotent and reproducible pipeline. Shipped inside the application as a
  hashed data pack and installed on first launch, with no network access.
- **Shell and map:** a routed application shell and an offline world map that draws the reference
  data over a Natural Earth basemap, with search, selection, layer controls and provenance for
  every record.

- **Fleet and flight:** simulated aircraft of real types, acquired, based, planned and flown
  between real aerodromes on the map, with fuel, wear and maintenance. The flight model is
  calibrated to each type's published range and states its assumptions.

- **Missions:** ten mission types as templates over one framework. Missions are created by hand
  or offered by the simulated world, routed with the flight planner, judged by objectives as the
  flight progresses, and recorded with their outcome. Risk is shown with the reasons for it.
- **Command and event log:** an append-only record of every action and what the world did in
  response, from which a saved world can be re-derived.
- **Environment and events:** simulated weather, computed from the world's seed, the time and the
  place, that changes flight time, fuel and risk and is drawn on the map. The world also produces
  events (aerodrome closures, navigation and logistics disruptions, maintenance findings, severe
  weather), each with stated consequences. None of it is real weather or real events.

- **Reports:** what the simulated world has done, over a period of simulation time: activity
  and its change on the period before, missions and their outcomes, how each aircraft was used
  and how much of the time it could be, fuel, maintenance, events and what the weather cost.
  Everything is derived from what the world recorded; nothing is stored for reports. Each section
  opens the records it names and exports as CSV or JSON.

There is no traffic or economy yet. Fuel is reported as mass: the simulation has no prices.

## Requirements

- Windows 10 or 11 with the WebView2 runtime (included in Windows 11)
- Node.js 24 or later
- Rust (stable, MSVC toolchain) and the Visual Studio C++ build tools

No account, API key or paid service is needed. Running the application needs no network
connection. Building it needs one once, to download the public reference datasets.

## Getting started

```sh
npm install
npm run data:fetch   # download the public reference datasets (once; needs a connection)
npm run data:build   # build the reference data pack and the offline basemap
npm run dev          # run the desktop app with hot reload
```

```sh
npm run ci               # format, lint, type-check and all tests (TypeScript and Rust)
npm run build            # data:build, then the release executable and installer
npm run verify:world     # replay the saved world from its seed and log and confirm it matches
npm run verify:reference # check and fingerprint the reference data in the database
```

Application data is stored in `%APPDATA%\dev.aegis.desktop\`. Exported reports are written to
`exports` inside it. Delete `aegis.db` there to start a
new world; the reference data is reinstalled from the bundle on the next launch. Set
`AEGIS_DATA_DIR` to use a different directory.

## Layout

```
apps/desktop        Tauri shell, workers, map engine, screens
  src-tauri         Rust core: SQLite ownership, migrations, session gate
packages/domain     Pure value types and rules
packages/sim        Simulation engine and runner
packages/db         Drizzle schema, migrations, persistence
packages/ingest     Reference-data pipeline: normalise, load, data pack, basemap
packages/ui         Design system: tokens and components
data                Curated reference files and the lock that pins downloaded sources
docs                Architecture, design system, reference data, decision records
```

## Documentation

- [Architecture](docs/architecture.md)
- [Design system](docs/design-system.md)
- [Reference data](docs/reference-data.md)
- [Architecture decision records](docs/adr/README.md)

## Licence

The code is released under the [MIT License](LICENSE). Reference data keeps the licence of its
source; see [NOTICE.md](NOTICE.md).
