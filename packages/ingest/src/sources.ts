import type { schema } from '@aegis/db';

type DataSource = typeof schema.refDataSource.$inferInsert;

/**
 * Every publisher AEGIS takes reference data from, with the terms under which it is used.
 * Licences were checked against each publisher's own statement before the source was added.
 */
export const DATA_SOURCES = {
  ourairports: {
    id: 'ourairports',
    name: 'OurAirports',
    publisher: 'OurAirports contributors (David Megginson)',
    url: 'https://ourairports.com/data/',
    licence: 'Public domain',
    licenceNote:
      'OurAirports states that all of its data is released to the public domain, with no guarantee of accuracy or fitness for use. It is community-maintained.',
  },
  'natural-earth': {
    id: 'natural-earth',
    name: 'Natural Earth',
    publisher: 'Natural Earth contributors',
    url: 'https://www.naturalearthdata.com/',
    licence: 'Public domain',
    licenceNote:
      'Natural Earth states that all versions of its raster and vector map data are in the public domain.',
  },
  'aegis-curated': {
    id: 'aegis-curated',
    name: 'AEGIS curated reference data',
    publisher: 'AEGIS project',
    url: 'data/curated/',
    licence: 'Project-owned',
    licenceNote:
      'Hand-entered identity and classification of real aircraft types. Entries are unverified until checked against a retrieved source.',
  },
  wikipedia: {
    id: 'wikipedia',
    name: 'Wikipedia (English)',
    publisher: 'Wikipedia contributors',
    url: 'https://en.wikipedia.org/',
    licence: 'CC BY-SA 4.0 (article text)',
    licenceNote:
      'Only individual numeric facts are extracted from article specification templates, each attributed to a specific article revision. Article text is not copied. A tertiary source: values are source-asserted, not authoritative.',
  },
} as const satisfies Record<string, DataSource>;

export type DataSourceId = keyof typeof DATA_SOURCES;
