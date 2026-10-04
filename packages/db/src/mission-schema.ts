import { sql } from 'drizzle-orm';
import { check, index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { simAircraft } from './fleet-schema';

/*
 * Missions and the operating area (ADR 0017). Fictional AEGIS state, written only by simulation
 * checkpoints. Finished missions are kept as history.
 */

export const MISSION_TYPES = [
  'training',
  'patrol',
  'reconnaissance',
  'logistics',
  'transport',
  'ferry',
  'emergency_response',
  'intercept',
  'search_and_rescue',
  'exercise',
] as const;

export const MISSION_STATUSES = [
  'offered',
  'draft',
  'planned',
  'accepted',
  'active',
  'completed',
  'failed',
  'cancelled',
  'rejected',
  'expired',
] as const;

export const MISSION_SOURCES = ['manual', 'generated'] as const;
export const MISSION_PRIORITIES = ['routine', 'priority', 'urgent'] as const;

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export const simMission = sqliteTable(
  'sim_mission',
  {
    /** For example `MSN-000001`. */
    id: text('id').primaryKey(),
    type: text('type', { enum: MISSION_TYPES }).notNull(),
    /** `manual`: created by the player. `generated`: an opportunity from the simulated world. */
    source: text('source', { enum: MISSION_SOURCES }).notNull(),
    status: text('status', { enum: MISSION_STATUSES }).notNull(),
    priority: text('priority', { enum: MISSION_PRIORITIES }).notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    aircraftId: text('aircraft_id').references(() => simAircraft.id),
    /** The flight that carries the mission out. `sim_flight.mission_id` is the enforced link. */
    flightId: text('flight_id'),
    createdTick: integer('created_tick').notNull(),
    acceptedTick: integer('accepted_tick'),
    plannedStartTick: integer('planned_start_tick'),
    actualStartTick: integer('actual_start_tick'),
    completedTick: integer('completed_tick'),
    /** Generated opportunities: the tick by which the player must answer. */
    expiresTick: integer('expires_tick'),
    completeByTick: integer('complete_by_tick'),
    /** JSON: what the mission asks for, before an aircraft and a route are chosen. */
    brief: text('brief').notNull(),
    /** JSON: route, cruise altitude and speed; NULL until planned. */
    plan: text('plan'),
    /** JSON: fuel and payload; NULL until planned. */
    load: text('load'),
    /** JSON array: each objective with its status and progress. */
    objectives: text('objectives').notNull(),
    /** JSON: the planner's figures and the risk recorded at acceptance. */
    assessment: text('assessment'),
    /** JSON: how the mission ended. */
    outcome: text('outcome'),
  },
  (t) => [
    index('sim_mission_status_idx').on(t.status),
    index('sim_mission_aircraft_idx').on(t.aircraftId),
    check('sim_mission_type_known', sql`${t.type} in (${quoted(MISSION_TYPES)})`),
    check('sim_mission_status_known', sql`${t.status} in (${quoted(MISSION_STATUSES)})`),
    check('sim_mission_source_known', sql`${t.source} in (${quoted(MISSION_SOURCES)})`),
    check('sim_mission_priority_known', sql`${t.priority} in (${quoted(MISSION_PRIORITIES)})`),
    // An active mission has a flight.
    check(
      'sim_mission_active_has_flight',
      sql`${t.status} <> 'active' or ${t.flightId} is not null`,
    ),
    // Only the world offers opportunities.
    check(
      'sim_mission_offer_is_generated',
      sql`${t.status} not in ('offered', 'rejected', 'expired') or ${t.source} = 'generated'`,
    ),
    // A mission committed to an aircraft has one, with a route and a load.
    check(
      'sim_mission_committed_is_planned',
      sql`${t.status} not in ('planned', 'accepted', 'active') or (${t.aircraftId} is not null and ${t.plan} is not null and ${t.load} is not null)`,
    ),
  ],
);

/** The operating area: public aerodromes copied into the world so that generation never reads `ref_*`. */
export const simPlace = sqliteTable(
  'sim_place',
  {
    /** Position in the operating area, from 0. The order is part of the world's state. */
    ordinal: integer('ordinal').primaryKey(),
    /** Soft link to the reference aerodrome the place was copied from. */
    refId: text('ref_id'),
    code: text('code'),
    name: text('name').notNull(),
    lat: real('lat').notNull(),
    lon: real('lon').notNull(),
    elevationM: real('elevation_m').notNull(),
  },
  (t) => [
    check('sim_place_lat_range', sql`${t.lat} between -90 and 90`),
    check('sim_place_lon_range', sql`${t.lon} between -180 and 180`),
  ],
);
