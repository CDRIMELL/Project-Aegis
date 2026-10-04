import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/*
 * Table families (ADR 0011):
 *   ref_*  sourced reference data, never written by the simulation
 *   sim_*  state of the simulated world
 *   sys_*  application records: users, sessions, settings, audit
 *
 * Changing this file requires `npm run db:generate` and committing the generated migration.
 */

export * from './fleet-schema';
export * from './reference-schema';

/** Identity of the simulated world. Exactly one row. */
export const simWorld = sqliteTable(
  'sim_world',
  {
    id: integer('id').primaryKey(),
    seed: text('seed').notNull(),
    /** Simulation rules version that produced this world. */
    modelVersion: integer('model_version').notNull(),
    /** Simulation instant at tick 0, Unix milliseconds. */
    epochMs: integer('epoch_ms').notNull(),
    createdWallMs: integer('created_wall_ms').notNull(),
    /** Whether this world has been given its starter fleet. It is given one only once. */
    starterFleetSeeded: integer('starter_fleet_seeded', { mode: 'boolean' })
      .notNull()
      .default(false),
  },
  (t) => [check('sim_world_singleton', sql`${t.id} = 1`)],
);

/** The simulation clock. Exactly one row. */
export const simClock = sqliteTable(
  'sim_clock',
  {
    id: integer('id').primaryKey(),
    simTimeMs: integer('sim_time_ms').notNull(),
    tick: integer('tick').notNull(),
    speed: integer('speed').notNull(),
    running: integer('running', { mode: 'boolean' }).notNull(),
  },
  (t) => [
    check('sim_clock_singleton', sql`${t.id} = 1`),
    check('sim_clock_tick_non_negative', sql`${t.tick} >= 0`),
    check('sim_clock_speed_supported', sql`${t.speed} in (1, 2, 5, 10, 50, 100)`),
  ],
);

/** Bookkeeping for the checkpoint currently held by the database (ADR 0004). Exactly one row. */
export const simCheckpoint = sqliteTable(
  'sim_checkpoint',
  {
    id: integer('id').primaryKey(),
    seq: integer('seq').notNull(),
    /** Wall-clock time the checkpoint was captured, Unix milliseconds. */
    wallMs: integer('wall_ms').notNull(),
    integrityDigest: integer('integrity_digest').notNull(),
  },
  (t) => [
    check('sim_checkpoint_singleton', sql`${t.id} = 1`),
    check('sim_checkpoint_seq_positive', sql`${t.seq} > 0`),
  ],
);

/** State of each named random stream (ADR 0006). */
export const simRngStream = sqliteTable(
  'sim_rng_stream',
  {
    name: text('name').primaryKey(),
    /** 32 lowercase hexadecimal characters. */
    state: text('state').notNull(),
  },
  (t) => [check('sim_rng_stream_state_length', sql`length(${t.state}) = 32`)],
);
