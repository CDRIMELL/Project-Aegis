CREATE TABLE `sim_career_day` (
	`number` integer PRIMARY KEY NOT NULL,
	`started_tick` integer NOT NULL,
	`ended_tick` integer,
	`counters` text NOT NULL,
	`aircraft_seconds` integer NOT NULL,
	`ready_seconds` integer NOT NULL,
	`readiness_low` real,
	`readiness_high` real,
	CONSTRAINT "sim_career_day_number_positive" CHECK("sim_career_day"."number" >= 1),
	CONSTRAINT "sim_career_day_start_non_negative" CHECK("sim_career_day"."started_tick" >= 0),
	CONSTRAINT "sim_career_day_end_after_start" CHECK("sim_career_day"."ended_tick" is null or "sim_career_day"."ended_tick" >= "sim_career_day"."started_tick"),
	CONSTRAINT "sim_career_day_ready_within_owned" CHECK("sim_career_day"."ready_seconds" >= 0 and "sim_career_day"."ready_seconds" <= "sim_career_day"."aircraft_seconds")
);
--> statement-breakpoint
ALTER TABLE `sim_world` ADD `career_established_tick` integer;--> statement-breakpoint
ALTER TABLE `sim_world` ADD `routine_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sim_world` ADD `routine_tasked` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sim_mission` ADD `routine` integer DEFAULT false NOT NULL;