CREATE TABLE `sim_checkpoint` (
	`id` integer PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`wall_ms` integer NOT NULL,
	`integrity_digest` integer NOT NULL,
	CONSTRAINT "sim_checkpoint_singleton" CHECK("sim_checkpoint"."id" = 1),
	CONSTRAINT "sim_checkpoint_seq_positive" CHECK("sim_checkpoint"."seq" > 0)
);
--> statement-breakpoint
CREATE TABLE `sim_clock` (
	`id` integer PRIMARY KEY NOT NULL,
	`sim_time_ms` integer NOT NULL,
	`tick` integer NOT NULL,
	`speed` integer NOT NULL,
	`running` integer NOT NULL,
	CONSTRAINT "sim_clock_singleton" CHECK("sim_clock"."id" = 1),
	CONSTRAINT "sim_clock_tick_non_negative" CHECK("sim_clock"."tick" >= 0),
	CONSTRAINT "sim_clock_speed_supported" CHECK("sim_clock"."speed" in (1, 2, 5, 10, 50, 100))
);
--> statement-breakpoint
CREATE TABLE `sim_rng_stream` (
	`name` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	CONSTRAINT "sim_rng_stream_state_length" CHECK(length("sim_rng_stream"."state") = 32)
);
--> statement-breakpoint
CREATE TABLE `sim_world` (
	`id` integer PRIMARY KEY NOT NULL,
	`seed` text NOT NULL,
	`model_version` integer NOT NULL,
	`epoch_ms` integer NOT NULL,
	`created_wall_ms` integer NOT NULL,
	CONSTRAINT "sim_world_singleton" CHECK("sim_world"."id" = 1)
);
