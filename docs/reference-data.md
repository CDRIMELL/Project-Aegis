# Reference data

Reference data is the real, sourced part of the AEGIS world: countries, aerodromes, runways, cities
and aircraft types. It lives in the `ref_*` tables and is written only by the ingestion pipeline
(`@aegis/ingest`). The decisions behind it are in
[ADR 0012](adr/0012-reference-data-and-ingestion.md) and
[ADR 0013](adr/0013-reference-data-pack.md).

## What is imported

| Dataset                            | Table                    | Source                          | Records |
| ---------------------------------- | ------------------------ | ------------------------------- | ------- |
| `ourairports-countries`            | `ref_country`            | OurAirports `countries.csv`     | 249     |
| `ourairports-airports`             | `ref_location`           | OurAirports `airports.csv`      | 48,052  |
| `ourairports-runways`              | `ref_runway`             | OurAirports `runways.csv`       | 35,418  |
| `natural-earth-cities`             | `ref_location`           | Natural Earth populated places  | 7,342   |
| `aircraft-types`                   | `ref_aircraft_type`      | `data/curated/` (hand-entered)  | 40      |
| `aircraft-attributes`              | `ref_aircraft_attribute` | Wikipedia specification blocks  | 225     |
| `aircraft-characteristics-curated` | `ref_aircraft_attribute` | Official pages, entered by hand | 32      |

Counts are from the files pinned in `data/sources.lock.json` on 2026-10-04. Of the runways, 14,974
have both threshold positions and can be drawn on the map.

Deliberately not imported:

- Heliports, seaplane bases, balloonports and closed aerodromes (38,113 records), and their runways.
- Any military classification of airfields. None is imported or inferred.
- Anything about an aircraft beyond dimensions, mass, speed, range, ceiling, engine arrangement and
  coarse role tags. The curated files' schemas reject any other field.

The offline basemap (Natural Earth land, borders and lakes) is not reference data. It is
presentation, prepared separately by `npm run data:basemap`, and nothing from it enters `ref_*`.

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
caveat. The map's detail panel and the Data screen show all of this for any record.

How confidence is assigned today:

| Data                                                        | Confidence | Verification      |
| ----------------------------------------------------------- | ---------- | ----------------- |
| Countries; cities                                           | high       | `source_asserted` |
| Aerodromes and runways (community-maintained source)        | medium     | `source_asserted` |
| Aircraft identity (hand-entered)                            | high       | `unverified`      |
| Aircraft characteristics from Wikipedia                     | medium     | `source_asserted` |
| The same, where the article describes a close variant       | low        | `source_asserted` |
| Aircraft characteristics from official pages (hand-entered) | high       | `unverified`      |
| The same, where the entry carries a caveat                  | medium     | `unverified`      |

## Aircraft characteristics

Two sources feed `ref_aircraft_attribute`. A type can have rows from both; nothing is reconciled.

**Wikipedia specification blocks** (`aircraft-attributes`). Read by a tool from each article's
`{{Aircraft specs}}` template, with the exact template parameter, a permanent link to the revision
and the section heading naming the variant. Two curated fields control variant mismatches:
`specCaveat` (close variant: imported at low confidence) and `specsNotApplicable` (materially
different variant: not imported).

**Official pages, entered by hand** (`aircraft-characteristics-curated`,
`data/curated/aircraft-characteristics.json`). For types whose article has no machine-readable
block. Every entry holds:

- the value **in the source's own unit**, converted in code, so no arithmetic is done by hand;
- `sourceText`, the publisher's wording, so the entry can be checked against the page;
- the publisher, URL and retrieval date.

Entries are `unverified` until someone checks them against the page. A value that could not be
established is recorded as `null` with the reason, and surfaces as a `value_not_established` issue.
No value in this file was typed from memory.

Coverage of the 13 types that had no characteristics after phase 2:

| Type                | Source used      | Values                                             |
| ------------------- | ---------------- | -------------------------------------------------- |
| Hawk T2             | Royal Air Force  | length, height, wingspan, max speed, ceiling       |
| Shadow R1           | Royal Air Force  | length, height, wingspan, max speed, ceiling       |
| Airbus A320neo      | Airbus           | length, wingspan, height, max take-off mass, range |
| Boeing 787-9        | Boeing           | length, wingspan, height, max take-off mass, range |
| Boeing 777-300ER    | Boeing           | length, wingspan, height, max take-off mass, range |
| ATR 72-600          | ATR              | length, wingspan, max take-off mass, range         |
| Airbus C295         | Airbus           | max cruise speed, ceiling                          |
| Protector (MQ-9B)   | General Atomics  | wingspan                                           |
| Voyager (A330 MRTT) | none established | —                                                  |
| F-35B               | none established | —                                                  |
| Airbus A380-800     | none established | —                                                  |
| Embraer E190        | none established | —                                                  |
| Dash 8-400          | none established | —                                                  |

The last five have no characteristics at all. For those, either the official page could not be
retrieved or it did not state the figures in its text.

## How reference data reaches an installation

```
raw sources --fetch--> data/raw/ --normalise--> datasets --+--> database        (npm run data:import)
   (pinned by data/sources.lock.json)                      |
                                                           +--> data pack --> bundled in the app
                                                                               --> installed on first launch
```

- **Development:** `npm run data:import` normalises and loads straight into the application's
  database.
- **Packaged application:** `npm run data:pack` freezes the normalised datasets into a pack with a
  hashed manifest. The build embeds it. On first launch the application verifies every file against
  the manifest and installs it through the same loader, then records the pack in
  `ref_pack_install`. No network is used. See ADR 0013.

Both paths produce identical reference rows. `npm run verify:reference` prints a fingerprint of the
reference tables; a directly imported database and a pack-installed one give the same value.

## Commands

```sh
npm run data:fetch            # download raw files into data/raw/ and pin them in the lock file
npm run data:aircraft-specs   # re-read aircraft characteristics from Wikipedia (about 2 minutes)
npm run data:import           # normalise and load into the application's database
npm run data:pack             # build the data pack shipped inside the application
npm run data:basemap          # build the offline basemap files
npm run data:build            # data:pack and data:basemap
npm run data:install-pack     # install the built pack into a database, as the application does
npm run verify:reference      # check and fingerprint the reference tables of a database
```

`data:import`, `data:install-pack` and `verify:reference` accept `-- --db path/to/other.db`
(`verify:reference` takes the path as its argument). Everything except `data:fetch` and
`data:aircraft-specs` reads only local files, and refuses a raw file whose SHA-256 differs from
`data/sources.lock.json`.

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
| A pack is byte-identical for the same input                      | `pack.test.ts` "is deterministic"                     |
| A pack install equals a direct import                            | `pack.test.ts` "produces exactly the reference state" |
| A corrupt or incomplete pack writes nothing                      | `pack.test.ts` "refuses a pack with a corrupt file"   |
| An installed pack is not installed again                         | `pack.test.ts` "does nothing when asked to install"   |
| An interrupted install is not recorded and resumes               | `pack.test.ts` "does not record a pack whose install" |

## Adding a source

1. Check the publisher's licence and add it to `packages/ingest/src/sources.ts`.
2. Write a normaliser: raw text in, validated records and issues out. Keep it pure.
3. If it is downloaded, add it to `REMOTE_FILES` in `packages/ingest/src/node/raw.ts`.
4. Add the dataset to `normaliseReferenceData` in dependency order.
5. Add fixtures and tests, including bad rows.
6. If normalisation of an existing dataset changes, bump `PIPELINE_VERSION`.
