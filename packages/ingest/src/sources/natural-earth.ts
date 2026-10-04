import { isValidLatLon } from '@aegis/domain';
import { z } from 'zod';
import { IssueLog, type LocationRecord, type NormalisedDataset, type RawInput } from '../model';

const SOURCE = 'natural-earth';

const collection = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(z.unknown()),
});

const feature = z.object({
  properties: z.object({
    ne_id: z.int().positive(),
    name: z.string().trim().min(1),
    iso_a2: z.string().nullish(),
    adm1name: z.string().nullish(),
    pop_max: z.number().nullish(),
  }),
  geometry: z.object({
    type: z.literal('Point'),
    coordinates: z.tuple([z.number(), z.number()]),
  }),
});

/**
 * Cities from Natural Earth "populated places" (GeoJSON).
 *
 * @param knownCountries ISO codes present in the country dataset. Natural Earth marks disputed
 * territories with a placeholder code; those cities are imported without a country link.
 */
export function normaliseCities(
  raw: RawInput,
  knownCountries: ReadonlySet<string>,
): NormalisedDataset<LocationRecord> {
  const parsed = collection.parse(JSON.parse(raw.text));
  const log = new IssueLog();
  const rows: LocationRecord[] = [];

  parsed.features.forEach((candidate, index) => {
    const result = feature.safeParse(candidate);
    if (!result.success) {
      const issue = result.error.issues[0];
      log.error(
        'invalid_feature',
        null,
        `Feature ${index}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'is invalid'}`,
      );
      return;
    }
    const { properties, geometry } = result.data;
    const key = String(properties.ne_id);
    const [lon, lat] = geometry.coordinates;
    if (!isValidLatLon(lat, lon)) {
      log.error('invalid_coordinates', key, `Coordinates ${lat}, ${lon} are not a valid position`);
      return;
    }

    let countryIso2 = properties.iso_a2?.trim() ?? null;
    if (countryIso2 !== null && !knownCountries.has(countryIso2)) {
      log.warning(
        'unknown_country',
        key,
        `Country code "${countryIso2}" for ${properties.name} is not in the country list`,
      );
      countryIso2 = null;
    }

    const population =
      properties.pop_max != null && properties.pop_max > 0 ? Math.round(properties.pop_max) : null;

    rows.push({
      sourceKey: key,
      confidence: 'high',
      verification: 'source_asserted',
      kind: 'city',
      name: properties.name,
      lat,
      lon,
      elevationM: null,
      countryIso2,
      regionCode: null,
      municipality: properties.adm1name?.trim() || null,
      ident: null,
      icao: null,
      iata: null,
      scheduledService: null,
      population,
    });
  });

  return {
    dataset: 'natural-earth-cities',
    sourceId: SOURCE,
    raw: { url: raw.url, sha256: raw.sha256, retrievedAt: raw.retrievedAt },
    rowsRead: parsed.features.length,
    rowsSkipped: 0,
    rows,
    issues: log.issues,
  };
}
