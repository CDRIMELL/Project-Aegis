import { sql } from 'drizzle-orm';
import { check, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/*
 * The career record (ADR 0031): one row for each command day. A closed day is never changed;
 * the open day is rewritten by each checkpoint. Career totals are sums over these rows and are
 * stored nowhere.
 */

export const simCareerDay = sqliteTable(
  'sim_career_day',
  {
    /** 1, 2, 3, ... with no gaps. */
    number: integer('number').primaryKey(),
    startedTick: integer('started_tick').notNull(),
    /** NULL while the day is open. */
    endedTick: integer('ended_tick'),
    /** JSON object: counter name to count. Only counters that have moved are present. */
    counters: text('counters').notNull(),
    /** Aircraft owned, summed over every step of the day. */
    aircraftSeconds: integer('aircraft_seconds').notNull(),
    /** Aircraft available or flying, summed over every step of the day. */
    readySeconds: integer('ready_seconds').notNull(),
    /** Lowest and highest share of aircraft ready at any step, 0 to 1. */
    readinessLow: real('readiness_low'),
    readinessHigh: real('readiness_high'),
  },
  (t) => [
    check('sim_career_day_number_positive', sql`${t.number} >= 1`),
    check('sim_career_day_start_non_negative', sql`${t.startedTick} >= 0`),
    check(
      'sim_career_day_end_after_start',
      sql`${t.endedTick} is null or ${t.endedTick} >= ${t.startedTick}`,
    ),
    check(
      'sim_career_day_ready_within_owned',
      sql`${t.readySeconds} >= 0 and ${t.readySeconds} <= ${t.aircraftSeconds}`,
    ),
  ],
);
