CREATE TABLE `sim_event` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`severity` real NOT NULL,
	`created_tick` integer NOT NULL,
	`start_tick` integer NOT NULL,
	`end_tick` integer NOT NULL,
	`place` text,
	`centre` text,
	`radius_m` real,
	`aircraft_id` text,
	`mission_id` text,
	`title` text NOT NULL,
	`description` text NOT NULL,
	CONSTRAINT "sim_event_type_known" CHECK("sim_event"."type" in ('aerodrome_closure', 'navigation_disruption', 'logistics_disruption', 'maintenance_finding', 'severe_weather')),
	CONSTRAINT "sim_event_status_known" CHECK("sim_event"."status" in ('scheduled', 'active', 'resolved', 'cancelled')),
	CONSTRAINT "sim_event_source_known" CHECK("sim_event"."source" in ('generated', 'derived')),
	CONSTRAINT "sim_event_severity_range" CHECK("sim_event"."severity" between 0 and 1),
	CONSTRAINT "sim_event_ends_after_start" CHECK("sim_event"."end_tick" >= "sim_event"."start_tick"),
	CONSTRAINT "sim_event_area_complete" CHECK(("sim_event"."centre" is null) = ("sim_event"."radius_m" is null))
);
--> statement-breakpoint
CREATE INDEX `sim_event_status_idx` ON `sim_event` (`status`);--> statement-breakpoint
ALTER TABLE `sim_world` ADD `next_event_number` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `sim_world` ADD `area_centre_lat` real;--> statement-breakpoint
ALTER TABLE `sim_world` ADD `area_centre_lon` real;--> statement-breakpoint
ALTER TABLE `sim_flight` ADD `still_air_duration_s` real;--> statement-breakpoint
ALTER TABLE `sim_flight` ADD `still_air_fuel_used_kg` real;--> statement-breakpoint
ALTER TABLE `ref_aircraft_attribute` ADD `variant` text;--> statement-breakpoint
ALTER TABLE `ref_aircraft_attribute` ADD `conditions` text;