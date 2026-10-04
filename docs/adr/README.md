# Architecture Decision Records

Each ADR records one decision: the context that forced it, what was decided, and what follows from it.
ADRs are immutable once accepted. To change a decision, add a new ADR that supersedes the old one.

| #                                              | Decision                                                         | Status   |
| ---------------------------------------------- | ---------------------------------------------------------------- | -------- |
| [0001](0001-repository-and-workspace.md)       | Repository outside OneDrive; npm workspaces with hard boundaries | Accepted |
| [0002](0002-simulation-runtime.md)             | TypeScript simulation core in a Web Worker                       | Accepted |
| [0003](0003-persistence-layer.md)              | Rust-owned SQLite connection; Drizzle over `sqlite-proxy`        | Accepted |
| [0004](0004-checkpoint-model.md)               | Whole-state checkpoints in a single transaction                  | Accepted |
| [0005](0005-simulation-time.md)                | Fixed timestep; resume from last persisted instant               | Accepted |
| [0006](0006-deterministic-rng.md)              | Seeded, named, persisted RNG streams                             | Accepted |
| [0007](0007-ingestion-language.md)             | Reference-data ingestion in TypeScript                           | Accepted |
| [0008](0008-basemap.md)                        | Offline public-domain basemap, separate from dynamic layers      | Accepted |
| [0009](0009-ui-libraries-and-design-system.md) | Token-driven design system; UI library set                       | Accepted |
| [0010](0010-security-hooks.md)                 | Security hooks from day one; encryption deferred                 | Accepted |
| [0011](0011-scenario-framing.md)               | Fictional operator and fleet over real reference data            | Accepted |
| [0012](0012-reference-data-and-ingestion.md)   | Reference data model and ingestion pipeline                      | Accepted |
| [0013](0013-reference-data-pack.md)            | Reference data ships as a release-time data pack                 | Accepted |
| [0014](0014-map-architecture.md)               | Map architecture: four tiers, driven outside React               | Accepted |
| [0015](0015-application-shell-and-routing.md)  | Application shell and routing                                    | Accepted |
| [0016](0016-fleet-and-flight-model.md)         | Fleet state and the flight model                                 | Accepted |
