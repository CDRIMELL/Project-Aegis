# Reference data

Reference data is the real, sourced part of the AEGIS world: countries, aerodromes, runways, cities
and aircraft types. It lives in the `ref_*` tables and is written only by the ingestion pipeline
(`@aegis/ingest`). The decisions behind it are in [ADR 0012](adr/0012-reference-data-and-ingestion.md).

## What is imported

| Dataset                 | Table                    | Source                         | Records |
| ----------------------- | ------------------------ | ------------------------------ | ------- |
| `ourairports-countries` | `ref_country`            | OurAirports `countries.csv`    | 249     |
| `ourairports-airports`  | `ref_location`           | OurAirports `airports.csv`     | 48,052  |
| `ourairports-runways`   | `ref_runway`             | OurAirports `runways.csv`      | 35,418  |
| `natural-earth-cities`  | `ref_location`           | Natural Earth populated places | 7,342   |
| `aircraft-types`        | `ref_aircraft_type`      | `data/curated/` (hand-entered) | 40      |
| `aircraft-attributes`   | `ref_aircraft_attribute` | Wikipedia specification blocks | 225     |

Counts are from the files pinned in `data/sources.lock.json` on 2026-10-04.

Deliberately not imported:

- Heliports, seaplane bases, balloonports and closed aerodromes (38,113 records), and their runways.
- Any military classification of airfields. None is imported or inferred.
- Anything about an aircraft beyond dimensions, mass, speed, range, ceiling, engine arrangement and
  coarse role tags. The curated file's schema rejects any other field.

## Provenance on every record

| Column         | Meaning                                                    |
| -------------- | ---------------------------------------------------------- |
| `id`           | `<source_id>:<source_key>`, for example `ourairports:2434` |
| `dataset`      | Which dataset owns the row                                 |
| `source_id`    | Publisher; see `ref_data_source` for its URL and licence   |
| `source_key`   | The publisher's own key for the record                     |
| `job_id`       | The import run that last inserted or changed the row       |
| `confidence`   | `high`, `medium` or `low`                                  |
| `verification` | `unverified`, `source_asserted` or `cross_checked`         |
| `content_hash` | Hash of the normalised content, used to detect change      |

From `job_id` you reach `ref_ingestion_job`: the raw file's URL, SHA-256 and retrieval time, and the
counts for that run. `ref_ingestion_issue` lists every record that run rejected or imported with a
caveat.

How confidence is assigned today:

| Data                                                        | Confidence | Verification      |
| ----------------------------------------------------------- | ---------- | ----------------- |
| Countries; cities                                           | high       | `source_asserted` |
| Aerodromes and runways (community-maintained source)        | medium     | `source_asserted` |
| Aircraft identity (hand-entered)                            | high       | `unverified`      |
| Aircraft characteristics                                    | medium     | `source_asserted` |
| Aircraft characteristics, article describes a close variant | low        | `source_asserted` |

## Aircraft characteristics

Each value is read by a tool from the `{{Aircraft specs}}` template of the type's English Wikipedia
article, and stored with the exact template parameter (`source_text`), a permanent link to the
revision read (`source_url`) and the section heading that names the variant (`note`). Nothing is
typed in from memory.

Two curated fields control variant mismatches:

- `specCaveat` — the block describes a close variant. Values are imported at `low` confidence with
  the caveat attached.
- `specsNotApplicable` — the block describes a materially different variant. Values are not
  imported; the gap is reported.

**Known gap:** 13 of the 40 types have no characteristics. Eleven articles present specifications as
tables or other templates the tool does not read; two (F-35B, Protector) are excluded because the
article describes a different variant. Each is recorded as a `no_characteristics` issue. A second
source is needed before the flight model (phase 4) can use those types.

Types without characteristics: Airbus A320neo, A380-800, A330 MRTT (Voyager), C295; ATR 72-600;
Boeing 777-300ER, 787-9; Dash 8-400; Embraer E190; BAE Hawk; Beechcraft Shadow R1; F-35B;
MQ-9B (Protector).

## Commands

```sh
npm run data:fetch            # download raw files into data/raw/ and pin them in the lock file
npm run data:aircraft-specs   # re-read aircraft characteristics from Wikipedia (about 2 minutes)
npm run data:import           # import everything into the application's database
npm run data:import -- --db path/to/other.db
```

`data:import` reads only local files. It refuses a raw file whose SHA-256 differs from
`data/sources.lock.json`, so a given commit always imports the same bytes.

## Guarantees, and the tests that hold them

| Guarantee                                                        | Test                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------- |
| Same input twice changes no reference row                        | `import.test.ts` "is idempotent"                      |
| Same input builds identical tables in a fresh database           | `import.test.ts` "is reproducible"                    |
| Only changed rows are written and re-attributed                  | `import.test.ts` "writes only the rows that changed"  |
| A dataset is imported completely or not at all                   | `import.test.ts` "writes nothing when any row cannot" |
| Every record read is imported, skipped or rejected with a reason | `import.test.ts` "full accounting"                    |
| Vanished records are reported, not deleted                       | `import.test.ts` "reports records that vanished"      |
| No out-of-scope aircraft field can enter                         | `normalise.test.ts` "rejects any entry carrying"      |

## Adding a source

1. Check the publisher's licence and add it to `packages/ingest/src/sources.ts`.
2. Write a normaliser: raw text in, validated records and issues out. Keep it pure.
3. If it is downloaded, add it to `REMOTE_FILES` in `packages/ingest/src/node/raw.ts`.
4. Add the dataset to `importReferenceData` in dependency order.
5. Add fixtures and tests, including bad rows.

## Not yet decided

How reference data reaches a packaged installation. Today `data:import` writes into the
application's database from a development checkout. A shipped build needs either a bundled data
pack imported on first run or an in-app import. This is a phase 3 decision.
