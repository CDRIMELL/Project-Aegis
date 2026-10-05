CREATE TABLE `__new_sim_event` (
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
	CONSTRAINT "sim_event_type_known" CHECK("__new_sim_event"."type" in ('aerodrome_closure', 'navigation_disruption', 'logistics_disruption', 'maintenance_finding', 'severe_weather', 'technical_caution')),
	CONSTRAINT "sim_event_status_known" CHECK("__new_sim_event"."status" in ('scheduled', 'active', 'resolved', 'cancelled')),
	CONSTRAINT "sim_event_source_known" CHECK("__new_sim_event"."source" in ('generated', 'derived')),
	CONSTRAINT "sim_event_severity_range" CHECK("__new_sim_event"."severity" between 0 and 1),
	CONSTRAINT "sim_event_ends_after_start" CHECK("__new_sim_event"."end_tick" >= "__new_sim_event"."start_tick"),
	CONSTRAINT "sim_event_area_complete" CHECK(("__new_sim_event"."centre" is null) = ("__new_sim_event"."radius_m" is null))
);
--> statement-breakpoint
INSERT INTO `__new_sim_event`("id", "type", "status", "source", "severity", "created_tick", "start_tick", "end_tick", "place", "centre", "radius_m", "aircraft_id", "mission_id", "title", "description") SELECT "id", "type", "status", "source", "severity", "created_tick", "start_tick", "end_tick", "place", "centre", "radius_m", "aircraft_id", "mission_id", "title", "description" FROM `sim_event`;--> statement-breakpoint
DROP TABLE `sim_event`;--> statement-breakpoint
ALTER TABLE `__new_sim_event` RENAME TO `sim_event`;--> statement-breakpoint
CREATE INDEX `sim_event_status_idx` ON `sim_event` (`status`);--> statement-breakpoint
-- sim_mission is rebuilt to admit the status `aborted`. sim_flight refers to it, and foreign keys
-- stay on inside a migration, so the links are set aside first and restored afterwards.
CREATE TABLE `__flight_mission` AS SELECT `id`, `mission_id` FROM `sim_flight` WHERE `mission_id` IS NOT NULL;--> statement-breakpoint
UPDATE `sim_flight` SET `mission_id` = NULL WHERE `mission_id` IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_sim_mission` (
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
	`acceptance` text,
	`assessment` text,
	`outcome` text,
	FOREIGN KEY (`aircraft_id`) REFERENCES `sim_aircraft`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sim_mission_type_known" CHECK("__new_sim_mission"."type" in ('training', 'patrol', 'reconnaissance', 'logistics', 'transport', 'ferry', 'emergency_response', 'intercept', 'search_and_rescue', 'exercise')),
	CONSTRAINT "sim_mission_status_known" CHECK("__new_sim_mission"."status" in ('offered', 'draft', 'planned', 'accepted', 'active', 'completed', 'failed', 'cancelled', 'aborted', 'rejected', 'expired')),
	CONSTRAINT "sim_mission_source_known" CHECK("__new_sim_mission"."source" in ('manual', 'generated')),
	CONSTRAINT "sim_mission_priority_known" CHECK("__new_sim_mission"."priority" in ('routine', 'priority', 'urgent')),
	CONSTRAINT "sim_mission_active_has_flight" CHECK("__new_sim_mission"."status" <> 'active' or "__new_sim_mission"."flight_id" is not null),
	CONSTRAINT "sim_mission_offer_is_generated" CHECK("__new_sim_mission"."status" not in ('offered', 'rejected', 'expired') or "__new_sim_mission"."source" = 'generated'),
	CONSTRAINT "sim_mission_committed_is_planned" CHECK("__new_sim_mission"."status" not in ('planned', 'accepted', 'active') or ("__new_sim_mission"."aircraft_id" is not null and "__new_sim_mission"."plan" is not null and "__new_sim_mission"."load" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_sim_mission`("id", "type", "source", "status", "priority", "title", "description", "aircraft_id", "flight_id", "created_tick", "accepted_tick", "planned_start_tick", "actual_start_tick", "completed_tick", "expires_tick", "complete_by_tick", "brief", "plan", "load", "objectives", "acceptance", "assessment", "outcome") SELECT "id", "type", "source", "status", "priority", "title", "description", "aircraft_id", "flight_id", "created_tick", "accepted_tick", "planned_start_tick", "actual_start_tick", "completed_tick", "expires_tick", "complete_by_tick", "brief", "plan", "load", "objectives", "acceptance", "assessment", "outcome" FROM `sim_mission`;--> statement-breakpoint
DROP TABLE `sim_mission`;--> statement-breakpoint
ALTER TABLE `__new_sim_mission` RENAME TO `sim_mission`;--> statement-breakpoint
CREATE INDEX `sim_mission_status_idx` ON `sim_mission` (`status`);--> statement-breakpoint
CREATE INDEX `sim_mission_aircraft_idx` ON `sim_mission` (`aircraft_id`);--> statement-breakpoint
UPDATE `sim_flight` SET `mission_id` = (SELECT `m`.`mission_id` FROM `__flight_mission` `m` WHERE `m`.`id` = `sim_flight`.`id`) WHERE `id` IN (SELECT `id` FROM `__flight_mission`);--> statement-breakpoint
DROP TABLE `__flight_mission`;--> statement-breakpoint
ALTER TABLE `sim_flight` ADD `projected_duration_s` real;--> statement-breakpoint
ALTER TABLE `sim_flight` ADD `projected_fuel_used_kg` real;--> statement-breakpoint
ALTER TABLE `sim_flight` ADD `planned_plan` text;--> statement-breakpoint
ALTER TABLE `sim_flight` ADD `revisions` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `sim_flight` ADD `caution` text;--> statement-breakpoint
-- An event now records when it actually ended (ADR 0026). A maintenance finding was created with
-- no end of its own and kept that when it was resolved; the log says when each event was
-- resolved, so the events resolved before this migration are given their real end from it.
UPDATE `sim_event` SET `end_tick` = (
  SELECT max(`l`.`tick`) FROM `sim_log` `l`
  WHERE `l`.`type` = 'eventResolved' AND json_extract(`l`.`payload`, '$.eventId') = `sim_event`.`id`
)
WHERE `status` = 'resolved' AND EXISTS (
  SELECT 1 FROM `sim_log` `l`
  WHERE `l`.`type` = 'eventResolved' AND json_extract(`l`.`payload`, '$.eventId') = `sim_event`.`id`
    AND `l`.`tick` >= `sim_event`.`start_tick`
);
