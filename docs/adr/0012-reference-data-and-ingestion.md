# 0012 — Reference data model and ingestion pipeline

- Status: Accepted
- Date: 2026-10-04

## Context

Phase 2 brings real public reference data into AEGIS. The handover requires that every sourced value
is attributable, that imports are repeatable, and that problems are reported instead of silently
dropped. ADR 0007 already fixes the language (TypeScript) and ADR 0011 the boundary between real
reference data and simulated state.

## Decision

### Provenance

- Every `ref_*` record carries `source_id`, `source_key`, `job_id` (the import that last wrote it),
  `confidence` and `verification`.
- `ref_data_source` holds the name, URL and licence of each source. `ref_ingestion_job` holds one
  row per import run: the SHA-256 and retrieval time of the raw file, counts and outcome.
  `ref_ingestion_issue` holds every rejected or suspicious record with a reason.
- `verification` has three levels:
  - `unverified` — entered by hand; not yet checked against a retrieved source.
  - `source_asserted` — taken mechanically from one identified source at a recorded revision.
  - `cross_checked` — agrees across two independent sources.
- Aircraft characteristics are stored one row per (type, attribute, source), so two sources that
  disagree are both kept.

### Identity and idempotency

- A record's primary key is `<source_id>:<source_key>`, for example `ourairports:2434`. Keys come
  from the source, never from insertion order, so the same input always yields the same database.
- Each record stores a hash of its normalised content. An import reads the existing keys and hashes,
  then writes only rows that are new or changed. Importing the same file twice changes nothing.
- One dataset is written in one transaction (ADR 0003): it is imported completely or not at all.
- Records that disappear from a source are reported but not deleted, because simulated state may
  refer to them.

### Reproducibility

- Raw downloads live in `data/raw/` and are not committed. `data/sources.lock.json` is committed and
  pins each raw file by URL, size, SHA-256 and retrieval time. An import refuses a raw file whose
  hash differs from the lock unless told to update it.
- The pipeline never reads the network or the clock while transforming. Wall-clock time appears only
  in job records.

### Pipeline shape

`@aegis/ingest` separates three steps: **parse** (raw bytes to rows), **normalise** (rows to
validated records plus issues; pure and unit-tested) and **load** (records to the database through
`SqlTransport`). Because loading uses the transport, the same code runs from the command line now
and from inside the application later.

### Sources

| Data                         | Source                            | Licence          |
| ---------------------------- | --------------------------------- | ---------------- |
| Countries, airports, runways | OurAirports                       | Public domain    |
| Cities                       | Natural Earth populated places    | Public domain    |
| Aircraft type identity       | Curated in `data/curated/`        | Project's own    |
| Aircraft characteristics     | Wikipedia specification templates | Facts; see below |

Aircraft characteristics are individual numeric facts extracted by a tool from each article's
specification template, with the article revision recorded. The article text is not copied. Each
value is stored with the exact source parameter it came from, and is labelled `source_asserted`:
one tertiary source, not an authoritative specification.

### Scope limits

- Aircraft types hold dimensions, mass, speed, range, ceiling, crew, engine arrangement and coarse
  role tags only. No weapon, sensor, payload or signature data (ADR 0011).
- No military classification of airfields is imported or inferred in this phase.

## Consequences

- Any value shown in the application can be traced to a source, a file hash and an import run.
- Values derived from a tertiary source are honest about it; later phases can add a second source
  and raise them to `cross_checked` without a schema change.
- Manual corrections are not part of this phase. They will be an overlay table, never an edit to an
  imported row, so re-imports stay idempotent.
- How reference data reaches the packaged application (bundled pack versus first-run import) is
  decided in phase 3.
