CREATE TABLE `sim_aircraft` (
	`id` text PRIMARY KEY NOT NULL,
	`type_id` text NOT NULL,
	`type_name` text NOT NULL,
	`category` text NOT NULL,
	`status` text NOT NULL,
	`home` text NOT NULL,
	`location` text,
	`fuel_kg` real NOT NULL,
	`payload_kg` real NOT NULL,
	`condition_pct` real NOT NULL,
	`flight_seconds_total` real NOT NULL,
	`flights` integer NOT NULL,
	`flight_seconds_since_maintenance` real NOT NULL,
	`maintenance_complete_tick` integer,
	`active_flight_id` text,
	`acquired_tick` integer NOT NULL,
	`performance` text,
	`performance_missing` text NOT NULL,
	CONSTRAINT "sim_aircraft_fuel_non_negative" CHECK("sim_aircraft"."fuel_kg" >= 0),
	CONSTRAINT "sim_aircraft_payload_non_negative" CHECK("sim_aircraft"."payload_kg" >= 0),
	CONSTRAINT "sim_aircraft_condition_range" CHECK("sim_aircraft"."condition_pct" between 0 and 100),
	CONSTRAINT "sim_aircraft_airborne_consistent" CHECK(("sim_aircraft"."status" = 'in_flight') = ("sim_aircraft"."location" is null))
);
--> statement-breakpoint
CREATE TABLE `sim_counter` (
	`name` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sim_flight` (
	`id` text PRIMARY KEY NOT NULL,
	`aircraft_id` text NOT NULL,
	`status` text NOT NULL,
	`departed_tick` integer NOT NULL,
	`arrived_tick` integer,
	`payload_kg` real NOT NULL,
	`fuel_at_departure_kg` real NOT NULL,
	`estimated_duration_s` real NOT NULL,
	`estimated_fuel_used_kg` real NOT NULL,
	`plan` text NOT NULL,
	`progress` text NOT NULL,
	FOREIGN KEY (`aircraft_id`) REFERENCES `sim_aircraft`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sim_flight_arrival_consistent" CHECK(("sim_flight"."status" = 'active') = ("sim_flight"."arrived_tick" is null))
);
--> statement-breakpoint
CREATE INDEX `sim_flight_aircraft_idx` ON `sim_flight` (`aircraft_id`);--> statement-breakpoint
CREATE INDEX `sim_flight_status_idx` ON `sim_flight` (`status`);--> statement-breakpoint
ALTER TABLE `sim_world` ADD `starter_fleet_seeded` integer DEFAULT false NOT NULL;