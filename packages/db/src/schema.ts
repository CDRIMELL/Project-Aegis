import { sql } from 'drizzle-orm';
import { check, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/*
 * Table families (ADR 0011):
 *   ref_*  sourced reference data, never written by the simulation
 *   sim_*  state of the simulated world
 *   sys_*  application records: users, sessions, settings, audit
 *
 * Changing this file requires `npm run db:generate` and committing the generated migration.
 */

export * from './career-schema';
export * from './event-schema';
export * from './fleet-schema';
export * from './log-schema';
export * from './mission-schema';
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
    /**
     * The tick from which `sim_log` records everything (ADR 0018). 0 for a world that has always
     * had a log; a world created before the log existed records the tick it gained one.
     */
    logCompleteFromTick: integer('log_complete_from_tick').notNull().default(0),
    /** Number the next mission will take. */
    nextMissionNumber: integer('next_mission_number').notNull().default(1),
    /** How many opportunities the world has generated. */
    opportunitiesGenerated: integer('opportunities_generated').notNull().default(0),
    /** Number the next world event will take. */
    nextEventNumber: integer('next_event_number').notNull().default(1),
    /** The point the operating area was chosen around; NULL until the world has one. */
    areaCentreLat: real('area_centre_lat'),
    areaCentreLon: real('area_centre_lon'),
    /** The tick the world became a career (ADR 0031); NULL for a world that is not one. */
    careerEstablishedTick: integer('career_established_tick'),
    /** Whether the world tasks and flies routine missions itself (ADR 0030). */
    routineEnabled: integer('routine_enabled', { mode: 'boolean' }).notNull().default(false),
    /** How many routine missions the world has tasked. */
    routineTasked: integer('routine_tasked').notNull().default(0),
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
