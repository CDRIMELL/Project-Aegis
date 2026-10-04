import { sql } from 'drizzle-orm';
import { check, index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/*
 * World events (ADR 0022). Fictional AEGIS state, written only by simulation checkpoints.
 * Finished events are kept as history. Ids of aircraft and missions are soft links.
 */

export const EVENT_TYPES = [
  'aerodrome_closure',
  'navigation_disruption',
  'logistics_disruption',
  'maintenance_finding',
  'severe_weather',
] as const;
export const EVENT_STATUSES = ['scheduled', 'active', 'resolved', 'cancelled'] as const;
export const EVENT_SOURCES = ['generated', 'derived'] as const;

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export const simEvent = sqliteTable(
  'sim_event',
  {
    /** For example `EVT-000001`. */
    id: text('id').primaryKey(),
    type: text('type', { enum: EVENT_TYPES }).notNull(),
    status: text('status', { enum: EVENT_STATUSES }).notNull(),
    /** `generated`: from the seeded stream. `derived`: read from the weather field. */
    source: text('source', { enum: EVENT_SOURCES }).notNull(),
    severity: real('severity').notNull(),
    createdTick: integer('created_tick').notNull(),
    startTick: integer('start_tick').notNull(),
    endTick: integer('end_tick').notNull(),
    /** JSON: the aerodrome concerned; NULL when the event has none. */
    place: text('place'),
    /** JSON: the centre of the area concerned; NULL when the event has none. */
    centre: text('centre'),
    radiusM: real('radius_m'),
    aircraftId: text('aircraft_id'),
    missionId: text('mission_id'),
    title: text('title').notNull(),
    description: text('description').notNull(),
  },
  (t) => [
    index('sim_event_status_idx').on(t.status),
    check('sim_event_type_known', sql`${t.type} in (${quoted(EVENT_TYPES)})`),
    check('sim_event_status_known', sql`${t.status} in (${quoted(EVENT_STATUSES)})`),
    check('sim_event_source_known', sql`${t.source} in (${quoted(EVENT_SOURCES)})`),
    check('sim_event_severity_range', sql`${t.severity} between 0 and 1`),
    check('sim_event_ends_after_start', sql`${t.endTick} >= ${t.startTick}`),
    // An area has both a centre and a radius, or neither.
    check('sim_event_area_complete', sql`(${t.centre} is null) = (${t.radiusM} is null)`),
  ],
);
