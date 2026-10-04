import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import { simMission } from './mission-schema';

/*
 * Simulated fleet (ADR 0016). Fictional AEGIS state, written only by simulation checkpoints.
 *
 * `type_id` and the reference ids inside `home` and `location` are soft links to `ref_*`: a saved
 * world carries everything it needs to run, so it restores whatever the reference tables hold.
 * Links between simulated rows are real foreign keys.
 */

export const AIRCRAFT_STATUSES = [
  'available',
  'in_flight',
  'maintenance_due',
  'in_maintenance',
  'unserviceable',
] as const;

/** One simulated aircraft: an instance of a real reference type. */
export const simAircraft = sqliteTable(
  'sim_aircraft',
  {
    /** Fictional identifier, for example `AEGIS-FT-001`. */
    id: text('id').primaryKey(),
    typeId: text('type_id').notNull(),
    typeName: text('type_name').notNull(),
    category: text('category').notNull(),
    status: text('status', { enum: AIRCRAFT_STATUSES }).notNull(),
    /** JSON: the aerodrome the aircraft is based at. */
    home: text('home').notNull(),
    /** JSON: where the aircraft is on the ground; NULL while airborne. */
    location: text('location'),
    fuelKg: real('fuel_kg').notNull(),
    payloadKg: real('payload_kg').notNull(),
    conditionPct: real('condition_pct').notNull(),
    flightSecondsTotal: real('flight_seconds_total').notNull(),
    flights: integer('flights').notNull(),
    flightSecondsSinceMaintenance: real('flight_seconds_since_maintenance').notNull(),
    maintenanceCompleteTick: integer('maintenance_complete_tick'),
    activeFlightId: text('active_flight_id'),
    acquiredTick: integer('acquired_tick').notNull(),
    /** JSON: the performance model the aircraft was acquired with; NULL if none could be derived. */
    performance: text('performance'),
    /** JSON array: characteristics the reference data lacked, when there is no model. */
    performanceMissing: text('performance_missing').notNull(),
  },
  (t) => [
    check('sim_aircraft_fuel_non_negative', sql`${t.fuelKg} >= 0`),
    check('sim_aircraft_payload_non_negative', sql`${t.payloadKg} >= 0`),
    check('sim_aircraft_condition_range', sql`${t.conditionPct} between 0 and 100`),
    // Airborne exactly when it has no ground location.
    check(
      'sim_aircraft_airborne_consistent',
      sql`(${t.status} = 'in_flight') = (${t.location} is null)`,
    ),
  ],
);

export const FLIGHT_STATUSES = ['active', 'completed', 'fuel_exhausted'] as const;

/** One simulated flight, active or finished. Finished flights are kept as history. */
export const simFlight = sqliteTable(
  'sim_flight',
  {
    id: text('id').primaryKey(),
    aircraftId: text('aircraft_id')
      .notNull()
      .references(() => simAircraft.id),
    status: text('status', { enum: FLIGHT_STATUSES }).notNull(),
    /** The mission this flight carries out; NULL for a flight launched on its own. */
    missionId: text('mission_id').references((): AnySQLiteColumn => simMission.id),
    departedTick: integer('departed_tick').notNull(),
    arrivedTick: integer('arrived_tick'),
    payloadKg: real('payload_kg').notNull(),
    fuelAtDepartureKg: real('fuel_at_departure_kg').notNull(),
    estimatedDurationS: real('estimated_duration_s').notNull(),
    estimatedFuelUsedKg: real('estimated_fuel_used_kg').notNull(),
    /** JSON: the approved plan: route points, cruise altitude and speed. */
    plan: text('plan').notNull(),
    /** JSON: phase, distance flown, altitude, speed, fuel, elapsed time. */
    progress: text('progress').notNull(),
  },
  (t) => [
    index('sim_flight_aircraft_idx').on(t.aircraftId),
    index('sim_flight_status_idx').on(t.status),
    check(
      'sim_flight_arrival_consistent',
      sql`(${t.status} = 'active') = (${t.arrivedTick} is null)`,
    ),
  ],
);

/** Next sequence number for each identifier prefix, so identifiers are never reused. */
export const simCounter = sqliteTable('sim_counter', {
  name: text('name').primaryKey(),
  value: integer('value').notNull(),
});
