CREATE TABLE `sim_mission` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`priority` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`aircraft_id` text,
	`flight_id` text,
	`created_tick` integer NOT NULL,
	`accepted_tick` integer,
	`planned_start_tick` integer,
	`actual_start_tick` integer,
	`completed_tick` integer,
	`expires_tick` integer,
	`complete_by_tick` integer,
	`brief` text NOT NULL,
	`plan` text,
	`load` text,
	`objectives` text NOT NULL,
	`assessment` text,
	`outcome` text,
	FOREIGN KEY (`aircraft_id`) REFERENCES `sim_aircraft`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sim_mission_type_known" CHECK("sim_mission"."type" in ('training', 'patrol', 'reconnaissance', 'logistics', 'transport', 'ferry', 'emergency_response', 'intercept', 'search_and_rescue', 'exercise')),
	CONSTRAINT "sim_mission_status_known" CHECK("sim_mission"."status" in ('offered', 'draft', 'planned', 'accepted', 'active', 'completed', 'failed', 'cancelled', 'rejected', 'expired')),
	CONSTRAINT "sim_mission_source_known" CHECK("sim_mission"."source" in ('manual', 'generated')),
	CONSTRAINT "sim_mission_priority_known" CHECK("sim_mission"."priority" in ('routine', 'priority', 'urgent')),
	CONSTRAINT "sim_mission_active_has_flight" CHECK("sim_mission"."status" <> 'active' or "sim_mission"."flight_id" is not null),
	CONSTRAINT "sim_mission_offer_is_generated" CHECK("sim_mission"."status" not in ('offered', 'rejected', 'expired') or "sim_mission"."source" = 'generated'),
	CONSTRAINT "sim_mission_committed_is_planned" CHECK("sim_mission"."status" not in ('planned', 'accepted', 'active') or ("sim_mission"."aircraft_id" is not null and "sim_mission"."plan" is not null and "sim_mission"."load" is not null))
);
--> statement-breakpoint
CREATE INDEX `sim_mission_status_idx` ON `sim_mission` (`status`);--> statement-breakpoint
CREATE INDEX `sim_mission_aircraft_idx` ON `sim_mission` (`aircraft_id`);--> statement-breakpoint
CREATE TABLE `sim_place` (
	`ordinal` integer PRIMARY KEY NOT NULL,
	`ref_id` text,
	`code` text,
	`name` text NOT NULL,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`elevation_m` real NOT NULL,
	CONSTRAINT "sim_place_lat_range" CHECK("sim_place"."lat" between -90 and 90),
	CONSTRAINT "sim_place_lon_range" CHECK("sim_place"."lon" between -180 and 180)
);
--> statement-breakpoint
ALTER TABLE `sim_world` ADD `next_mission_number` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `sim_world` ADD `opportunities_generated` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sim_flight` ADD `mission_id` text REFERENCES sim_mission(id);