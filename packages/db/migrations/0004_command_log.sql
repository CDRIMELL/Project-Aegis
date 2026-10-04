CREATE TABLE `sim_log` (
	`seq` integer PRIMARY KEY NOT NULL,
	`tick` integer NOT NULL,
	`kind` text NOT NULL,
	`type` text NOT NULL,
	`actor` text NOT NULL,
	`mission_id` text,
	`aircraft_id` text,
	`flight_id` text,
	`payload` text NOT NULL,
	CONSTRAINT "sim_log_seq_positive" CHECK("sim_log"."seq" > 0),
	CONSTRAINT "sim_log_tick_non_negative" CHECK("sim_log"."tick" >= 0),
	CONSTRAINT "sim_log_kind_known" CHECK("sim_log"."kind" in ('command', 'event')),
	CONSTRAINT "sim_log_actor_known" CHECK("sim_log"."actor" in ('player', 'system', 'world')),
	CONSTRAINT "sim_log_actor_matches_kind" CHECK(("sim_log"."kind" = 'event') = ("sim_log"."actor" = 'world'))
);
--> statement-breakpoint
CREATE INDEX `sim_log_mission_idx` ON `sim_log` (`mission_id`);--> statement-breakpoint
CREATE INDEX `sim_log_aircraft_idx` ON `sim_log` (`aircraft_id`);--> statement-breakpoint
CREATE INDEX `sim_log_tick_idx` ON `sim_log` (`tick`);--> statement-breakpoint
ALTER TABLE `sim_world` ADD `log_complete_from_tick` integer DEFAULT 0 NOT NULL;