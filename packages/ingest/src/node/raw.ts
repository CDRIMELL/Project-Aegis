import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { RawInput } from '../model';

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const RAW_DIR = join(REPO_ROOT, 'data', 'raw');
export const LOCK_PATH = join(REPO_ROOT, 'data', 'sources.lock.json');
export const CURATED_TYPES = 'data/curated/aircraft-types.json';
export const CURATED_ATTRIBUTES = 'data/curated/aircraft-attributes.wikipedia.json';
export const CURATED_CHARACTERISTICS = 'data/curated/aircraft-characteristics.json';
/** Where the release-time data pack is written: inside the desktop app's bundled assets. */
export const PACK_DIR = join(REPO_ROOT, 'apps', 'desktop', 'public', 'reference-pack');

/** Raw files that are downloaded, never committed, and pinned by the lock file (ADR 0012). */
export const REMOTE_FILES = {
  countries: {
    url: 'https://davidmegginson.github.io/ourairports-data/countries.csv',
    file: 'ourairports/countries.csv',
  },
  airports: {
    url: 'https://davidmegginson.github.io/ourairports-data/airports.csv',
    file: 'ourairports/airports.csv',
  },
  runways: {
    url: 'https://davidmegginson.github.io/ourairports-data/runways.csv',
    file: 'ourairports/runways.csv',
  },
  cities: {
    url: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson',
    file: 'natural-earth/ne_10m_populated_places_simple.geojson',
  },
  // Basemap cartography (ADR 0008), at three levels of detail.
  'basemap-countries-110m': naturalEarth('ne_110m_admin_0_countries'),
  'basemap-countries-50m': naturalEarth('ne_50m_admin_0_countries'),
  'basemap-countries-10m': naturalEarth('ne_10m_admin_0_countries'),
  'basemap-borders-50m': naturalEarth('ne_50m_admin_0_boundary_lines_land'),
  'basemap-borders-10m': naturalEarth('ne_10m_admin_0_boundary_lines_land'),
  'basemap-lakes-50m': naturalEarth('ne_50m_lakes'),
  'basemap-lakes-10m': naturalEarth('ne_10m_lakes'),
} as const;

function naturalEarth(name: string) {
  return {
    url: `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/${name}.geojson`,
    file: `natural-earth/${name}.geojson`,
  };
}

/** Where the offline basemap is written: inside the desktop app's bundled assets. */
export const BASEMAP_DIR = join(REPO_ROOT, 'apps', 'desktop', 'public', 'basemap');

export type RemoteName = keyof typeof REMOTE_FILES;

const lockEntry = z.object({
  url: z.url(),
  file: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.int().nonnegative(),
  retrievedAt: z.iso.datetime(),
});
const lockFile = z.object({ files: z.record(z.string(), lockEntry) });

export type LockFile = z.infer<typeof lockFile>;

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function readLock(): LockFile {
  if (!existsSync(LOCK_PATH)) return { files: {} };
  return lockFile.parse(JSON.parse(readFileSync(LOCK_PATH, 'utf8')));
}

function writeLock(lock: LockFile): void {
  const sorted = Object.fromEntries(
    Object.entries(lock.files).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(LOCK_PATH, `${JSON.stringify({ files: sorted }, null, 2)}\n`);
}

/** Downloads one raw file and pins it in the lock. Returns whether its content changed. */
export async function fetchRemote(
  name: RemoteName,
  now: () => Date,
): Promise<{ changed: boolean; bytes: number; sha256: string }> {
  const { url, file } = REMOTE_FILES[name];
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed for ${url}: HTTP ${response.status}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  const path = join(RAW_DIR, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);

  const lock = readLock();
  const hash = sha256(data);
  const changed = lock.files[name]?.sha256 !== hash;
  if (changed) {
    lock.files[name] = {
      url,
      file,
      sha256: hash,
      bytes: data.length,
      retrievedAt: now().toISOString(),
    };
    writeLock(lock);
  }
  return { changed, bytes: data.length, sha256: hash };
}

/**
 * Reads a downloaded raw file, refusing it unless its hash matches the lock. This is what makes an
 * import reproducible: the same lock always means the same input bytes.
 */
export function readRemote(name: RemoteName): RawInput {
  const entry = readLock().files[name];
  if (!entry) {
    throw new Error(`"${name}" is not in data/sources.lock.json. Run: npm run data:fetch`);
  }
  const path = join(RAW_DIR, entry.file);
  if (!existsSync(path)) {
    throw new Error(`Raw file ${entry.file} has not been downloaded. Run: npm run data:fetch`);
  }
  const data = readFileSync(path);
  const actual = sha256(data);
  if (actual !== entry.sha256) {
    throw new Error(
      `Raw file ${entry.file} does not match the lock (expected ${entry.sha256}, found ${actual}). ` +
        'Run "npm run data:fetch" to download it again and update the lock.',
    );
  }
  return {
    url: entry.url,
    sha256: entry.sha256,
    retrievedAt: entry.retrievedAt,
    text: data.toString('utf8'),
  };
}

/**
 * Reads a committed curated file. Line endings are normalised before hashing so a CRLF checkout
 * yields the same hash as an LF one.
 */
export function readCurated(repoPath: string, retrievedAt: (text: string) => string): RawInput {
  const text = readFileSync(join(REPO_ROOT, repoPath), 'utf8').replaceAll('\r\n', '\n');
  return { url: repoPath, sha256: sha256(text), retrievedAt: retrievedAt(text), text };
}
