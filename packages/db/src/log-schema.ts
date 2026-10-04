import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/*
 * The command and event log (ADR 0018). Append-only: checkpoints insert rows and never update or
 * delete them. The ids are soft links, because the log is history and outlives nothing it names.
 */

export const LOG_KINDS = ['command', 'event'] as const;
export const LOG_ACTORS = ['player', 'system', 'world'] as const;

export const simLog = sqliteTable(
  'sim_log',
  {
    /** Assigned by the engine: 1, 2, 3, ... with no gaps. */
    seq: integer('seq').primaryKey(),
    tick: integer('tick').notNull(),
    kind: text('kind', { enum: LOG_KINDS }).notNull(),
    /** The command's type or the event's name. */
    type: text('type').notNull(),
    actor: text('actor', { enum: LOG_ACTORS }).notNull(),
    missionId: text('mission_id'),
    aircraftId: text('aircraft_id'),
    flightId: text('flight_id'),
    /** JSON object. For a command, the whole command as it was applied. */
    payload: text('payload').notNull(),
  },
  (t) => [
    index('sim_log_mission_idx').on(t.missionId),
    index('sim_log_aircraft_idx').on(t.aircraftId),
    index('sim_log_tick_idx').on(t.tick),
    check('sim_log_seq_positive', sql`${t.seq} > 0`),
    check('sim_log_tick_non_negative', sql`${t.tick} >= 0`),
    check('sim_log_kind_known', sql`${t.kind} in ('command', 'event')`),
    check('sim_log_actor_known', sql`${t.actor} in ('player', 'system', 'world')`),
    // Commands come from outside the simulation; events come from the world.
    check('sim_log_actor_matches_kind', sql`(${t.kind} = 'event') = (${t.actor} = 'world')`),
  ],
);
