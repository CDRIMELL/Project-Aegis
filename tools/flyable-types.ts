/**
 * Lists which reference aircraft types the flight model can fly, and what each of the others lacks.
 *
 * Reads the reference tables of an AEGIS database and derives a performance model for every type,
 * exactly as the application does when an aircraft is acquired.
 *
 * Usage:  npx tsx tools/flyable-types.ts [path-to-aegis.db]
 */
import { join } from 'node:path';
import { derivePerformance, type EngineType } from '@aegis/domain';
import { NodeSqliteTransport } from '@aegis/db/node';

const CONFIDENCE_RANK: Readonly<Record<string, number>> = { high: 0, medium: 1, low: 2 };

const defaultPath = join(process.env.APPDATA ?? '.', 'dev.aegis.desktop', 'aegis.db');
const transport = new NodeSqliteTransport(process.argv[2] ?? defaultPath);
try {
  const types = transport.connection
    .prepare('SELECT id, slug, name, category, engine_type, uk_service_name FROM ref_aircraft_type')
    .all();
  const attributes = transport.connection
    .prepare('SELECT type_id, key, value, confidence, source_id FROM ref_aircraft_attribute')
    .all();

  const flyable: string[] = [];
  const unflyable: string[] = [];
  const fuelBasis: Record<string, string[]> = {};
  for (const type of types.sort((a, b) => String(a.slug).localeCompare(String(b.slug)))) {
    // The same choice the application makes: most confident source, ties to the lowest source id.
    const chosen = new Map<string, { value: number; rank: number; source: string }>();
    for (const attribute of attributes) {
      if (attribute.type_id !== type.id) continue;
      const candidate = {
        value: attribute.value as number,
        rank: CONFIDENCE_RANK[attribute.confidence as string] ?? 3,
        source: attribute.source_id as string,
      };
      const current = chosen.get(attribute.key as string);
      if (
        !current ||
        candidate.rank < current.rank ||
        (candidate.rank === current.rank && candidate.source < current.source)
      ) {
        chosen.set(attribute.key as string, candidate);
      }
    }
    const value = (key: string) => chosen.get(key)?.value ?? null;
    const result = derivePerformance({
      category: type.category as string,
      engineType: type.engine_type as EngineType,
      emptyMassKg: value('empty_mass_kg'),
      maxTakeoffMassKg: value('max_takeoff_mass_kg'),
      cruiseSpeedKmh: value('cruise_speed_kmh'),
      maxSpeedKmh: value('max_speed_kmh'),
      rangeKm: value('range_km'),
      ferryRangeKm: value('ferry_range_km'),
      serviceCeilingM: value('service_ceiling_m'),
      fuelCapacityKg: value('fuel_capacity_kg'),
      fuelCapacityL: value('fuel_capacity_l'),
    });
    const label = `${String(type.slug)}${type.uk_service_name ? ' [UK]' : ''}`;
    if (result.available) {
      flyable.push(label);
      const basis = result.model.fuelCapacityBasis ?? 'assumed';
      (fuelBasis[basis] ??= []).push(
        `${String(type.slug)} ${result.model.fuelCapacityKg} kg, calibrated to ${result.model.referenceRangeKind}`,
      );
    } else {
      unflyable.push(`${label}: lacks ${result.missing.join(', ')}`);
    }
  }

  console.log(
    JSON.stringify(
      { types: types.length, flyable: flyable.length, unflyable: unflyable.length },
      null,
      2,
    ),
  );
  console.log('\nFuel capacity basis of flyable types:');
  for (const [basis, list] of Object.entries(fuelBasis)) {
    console.log(`  ${basis} (${list.length})`);
    if (basis !== 'assumed') for (const line of list) console.log(`    ${line}`);
  }
  console.log('\nCannot fly:');
  for (const line of unflyable) console.log(`  ${line}`);
} finally {
  transport.close();
}
