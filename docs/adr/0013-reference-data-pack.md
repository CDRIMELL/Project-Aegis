# 0013 — Reference data ships as a release-time data pack

- Status: Accepted
- Date: 2026-10-04

## Context

Reference data must be present in a packaged installation without any network access on first
launch (ADR 0012 left this open). The pipeline that produces it must stay the single path for
provenance, issues and idempotency; a second, separate loader would be a way around all three.

## Decision

- A **pack** is the output of the normalise step, frozen: one JSON file per dataset and a
  `manifest.json` listing each file with its SHA-256, row count, issue count and the raw input
  (URL, SHA-256, retrieval time) it was normalised from.
- The pack is built at release time by `npm run data:pack` from the raw sources pinned in
  `data/sources.lock.json`, written into the desktop app's bundled assets, and embedded in the
  executable by the normal build. It is not committed. Building needs the raw files (a connection,
  once); running never does.
- **A pack's identity is the SHA-256 of its manifest.** There is no hand-maintained version number
  to forget to bump: any change to any record changes a file hash, which changes the manifest hash.
- The manifest also records the pack **format version** (layout of the files) and the **pipeline
  version** (normalisation rules). A build refuses a pack whose format or pipeline version is not
  its own.
- On every launch the application reads the bundled manifest and compares its hash with the newest
  row of `ref_pack_install`:
  - equal: nothing to do;
  - different or absent: every file is read and hash-checked **before anything is written**, then
    each dataset is loaded by the ordinary loader, then the pack is recorded in `ref_pack_install`.
- **Installing a pack uses the same `loadDataset` as a command-line import.** Jobs, per-row job
  links, issues, content hashes and "write only what changed" behave identically. The job records
  carry the original raw source hash, taken from the manifest.
- **Atomicity.** Each dataset is one transaction (ADR 0012). The pack as a whole is recorded only
  after all datasets succeed. If the process stops part-way, no install is recorded, so the next
  launch runs it again; datasets already written are found unchanged. The reference tables are
  therefore never left claiming a pack they do not fully contain.
- The install runs in its own Web Worker, through the same SQL relay as the simulation, so the
  interface stays responsive.

## Updating reference data

Refresh the raw sources (`npm run data:fetch`), rebuild, ship. The new build's pack has a new
identity; on first launch it loads, writing only rows that are new or changed, and adds a row to
`ref_pack_install`. Earlier rows remain as history. A change to the pack layout bumps the format
version; a change to normalisation rules bumps the pipeline version.

## Alternatives considered

- **Ship a pre-built SQLite file and copy tables across.** Faster, but a second write path that
  bypasses jobs and issue recording, and couples the pack to the schema migration level.
- **Ship raw sources and normalise on first launch.** Largest bundle, slowest first launch, and
  parsing 86,000 CSV rows in the webview for no benefit: normalisation is deterministic, so doing
  it at release time loses nothing.
- **Download on first launch.** Rejected: first launch must work offline.

## Consequences

- First launch does a few seconds of work, once. Later launches read one small file.
- The hash checks detect a corrupt or mismatched bundle. They are not a defence against someone
  who can modify the installed application; that is outside this decision's scope.
- A pack-installed database and a directly imported one hold identical reference rows. A tool,
  `npm run verify:reference`, fingerprints the reference tables so this can be checked on any
  database.
- The bundle grows by the size of the pack (about 14 MB before the build's own compression).
