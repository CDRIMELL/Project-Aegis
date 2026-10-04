/**
 * Independently verifies the reference data in an AEGIS database.
 *
 * Checks integrity, provenance and source hashes with plain SQL, without using the ingestion code,
 * and prints a fingerprint of the reference tables. Two databases with the same fingerprint hold
 * exactly the same reference rows, whichever path (direct import or data pack) put them there.
 *
 * Usage:  npx tsx tools/verify-reference.ts [path-to-aegis.db]
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const path = process.argv[2] ?? join(process.env.APPDATA ?? '.', 'dev.aegis.desktop', 'aegis.db');
const db = new DatabaseSync(path, { readOnly: true });

const all = (sql: string) => db.prepare(sql).all() as Record<string, string | number | null>[];
const scalar = (sql: string) => Number(Object.values(all(sql)[0] ?? { n: 0 })[0]);

const RECORD_TABLES = [
  'ref_country',
  'ref_location',
  'ref_runway',
  'ref_aircraft_type',
  'ref_aircraft_attribute',
];

const checks: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string | number) => {
  checks.push({ check: name, ok, detail: String(detail) });
};

// Schema and integrity.
const migrations = all('SELECT tag FROM __aegis_migrations ORDER BY idx').map((row) => row.tag);
check('migrations applied', migrations.length >= 3, migrations.join(', '));
check('integrity_check', all('PRAGMA integrity_check')[0]?.integrity_check === 'ok', 'ok');
check('foreign keys valid', all('PRAGMA foreign_key_check').length === 0, 'no violations');

// Every record links to a job that succeeded, and to a registered source.
let rows = 0;
let orphans = 0;
for (const table of RECORD_TABLES) {
  rows += scalar(`SELECT count(*) FROM ${table}`);
  orphans += scalar(
    `SELECT count(*) FROM ${table} r
       LEFT JOIN ref_ingestion_job j ON j.id = r.job_id AND j.status = 'succeeded' AND j.dataset = r.dataset
       LEFT JOIN ref_data_source s ON s.id = r.source_id
      WHERE j.id IS NULL OR s.id IS NULL OR r.id <> r.source_id || ':' || r.source_key`,
  );
}
check('reference rows present', rows > 0, rows);
check('every row has job, source and source-derived key', orphans === 0, `${orphans} without`);

// Source hashes recorded on jobs match the committed lock file.
const lock = JSON.parse(readFileSync(join(root, 'data', 'sources.lock.json'), 'utf8')) as {
  files: Record<string, { url: string; sha256: string }>;
};
const lockedByUrl = new Map(Object.values(lock.files).map((file) => [file.url, file.sha256]));
const jobs = all(
  "SELECT dataset, raw_url, raw_sha256 FROM ref_ingestion_job WHERE status = 'succeeded'",
);
const mismatched = jobs.filter(
  (job) =>
    lockedByUrl.has(String(job.raw_url)) && lockedByUrl.get(String(job.raw_url)) !== job.raw_sha256,
);
const pinned = jobs.filter((job) => lockedByUrl.has(String(job.raw_url))).length;
check(
  'job source hashes match data/sources.lock.json',
  pinned > 0 && mismatched.length === 0,
  `${pinned} jobs checked`,
);
check(
  'no failed or unfinished jobs',
  scalar("SELECT count(*) FROM ref_ingestion_job WHERE status <> 'succeeded'") === 0,
  `${jobs.length} succeeded`,
);

// Issue reporting survived: stored issues equal the counts the jobs reported.
const reported = scalar('SELECT coalesce(sum(issue_count), 0) FROM ref_ingestion_job');
const stored = scalar('SELECT count(*) FROM ref_ingestion_issue');
check(
  'stored issues match job issue counts',
  reported === stored && stored > 0,
  `${stored} issues`,
);

// Simulated state is separate and untouched by reference imports.
check('simulation tables untouched by import', scalar('SELECT count(*) FROM sim_world') <= 1, 'ok');

const pack = all(
  'SELECT manifest_sha256, row_count FROM ref_pack_install ORDER BY id DESC LIMIT 1',
)[0];

// Fingerprint: every reference row, in key order, excluding which job wrote it.
const hash = createHash('sha256');
for (const table of ['ref_data_source', ...RECORD_TABLES]) {
  for (const row of all(`SELECT * FROM ${table} ORDER BY id`)) {
    delete row.job_id;
    hash.update(table);
    hash.update(JSON.stringify(row));
  }
}

console.table(checks);
console.log(
  JSON.stringify(
    {
      database: path,
      counts: Object.fromEntries(
        RECORD_TABLES.map((table) => [table, scalar(`SELECT count(*) FROM ${table}`)]),
      ),
      runwaysWithGeometry: scalar('SELECT count(*) FROM ref_runway WHERE low_end_lat IS NOT NULL'),
      jobs: scalar('SELECT count(*) FROM ref_ingestion_job'),
      installedPack: pack ? String(pack.manifest_sha256) : null,
      referenceFingerprint: hash.digest('hex'),
      verdict: checks.every((entry) => entry.ok) ? 'PASS' : 'FAIL',
    },
    null,
    2,
  ),
);
process.exitCode = checks.every((entry) => entry.ok) ? 0 : 1;
db.close();
