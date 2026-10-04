/**
 * Creates a database migrated by the Node runner, for the Rust test that proves both migration
 * runners agree (`accepts_a_database_migrated_by_the_node_runner`).
 *
 * Run through `npm run rust:prepare`.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openNodeDatabase } from '@aegis/db/node';

const root = fileURLToPath(new URL('..', import.meta.url));
const path = join(root, 'apps', 'desktop', 'src-tauri', 'target', 'parity', 'node-migrated.db');

mkdirSync(dirname(path), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(path + suffix, { force: true });
}
openNodeDatabase(path).close();
console.log(`Wrote ${path}`);
