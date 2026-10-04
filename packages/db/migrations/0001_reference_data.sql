CREATE TABLE `ref_aircraft_attribute` (
	`id` text PRIMARY KEY NOT NULL,
	`dataset` text NOT NULL,
	`source_id` text NOT NULL,
	`source_key` text NOT NULL,
	`job_id` integer NOT NULL,
	`confidence` text NOT NULL,
	`verification` text NOT NULL,
	`content_hash` text NOT NULL,
	`type_id` text NOT NULL,
	`key` text NOT NULL,
	`value` real NOT NULL,
	`source_text` text NOT NULL,
	`source_url` text NOT NULL,
	`note` text,
	FOREIGN KEY (`source_id`) REFERENCES `ref_data_source`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `ref_ingestion_job`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`type_id`) REFERENCES `ref_aircraft_type`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ref_aircraft_attribute_type_idx` ON `ref_aircraft_attribute` (`type_id`,`key`);--> statement-breakpoint
CREATE TABLE `ref_aircraft_type` (
	`id` text PRIMARY KEY NOT NULL,
	`dataset` text NOT NULL,
	`source_id` text NOT NULL,
	`source_key` text NOT NULL,
	`job_id` integer NOT NULL,
	`confidence` text NOT NULL,
	`verification` text NOT NULL,
	`content_hash` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`manufacturer` text NOT NULL,
	`category` text NOT NULL,
	`engine_type` text NOT NULL,
	`engine_count` integer NOT NULL,
	`uk_service_name` text,
	`roles` text NOT NULL,
	`reference_url` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `ref_data_source`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `ref_ingestion_job`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ref_aircraft_type_slug_unique` ON `ref_aircraft_type` (`slug`);--> statement-breakpoint
CREATE TABLE `ref_country` (
	`id` text PRIMARY KEY NOT NULL,
	`dataset` text NOT NULL,
	`source_id` text NOT NULL,
	`source_key` text NOT NULL,
	`job_id` integer NOT NULL,
	`confidence` text NOT NULL,
	`verification` text NOT NULL,
	`content_hash` text NOT NULL,
	`iso2` text NOT NULL,
	`name` text NOT NULL,
	`continent` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `ref_data_source`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `ref_ingestion_job`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ref_country_iso2_unique` ON `ref_country` (`iso2`);--> statement-breakpoint
CREATE TABLE `ref_data_source` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`publisher` text NOT NULL,
	`url` text NOT NULL,
	`licence` text NOT NULL,
	`licence_note` text
);
--> statement-breakpoint
CREATE TABLE `ref_ingestion_issue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`severity` text NOT NULL,
	`code` text NOT NULL,
	`record_key` text,
	`message` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `ref_ingestion_job`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ref_ingestion_issue_job_idx` ON `ref_ingestion_issue` (`job_id`);--> statement-breakpoint
CREATE TABLE `ref_ingestion_job` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dataset` text NOT NULL,
	`source_id` text NOT NULL,
	`pipeline_version` integer NOT NULL,
	`status` text NOT NULL,
	`started_wall_ms` integer NOT NULL,
	`finished_wall_ms` integer,
	`raw_url` text NOT NULL,
	`raw_sha256` text NOT NULL,
	`raw_retrieved_at` text NOT NULL,
	`rows_read` integer DEFAULT 0 NOT NULL,
	`rows_skipped` integer DEFAULT 0 NOT NULL,
	`rows_rejected` integer DEFAULT 0 NOT NULL,
	`rows_inserted` integer DEFAULT 0 NOT NULL,
	`rows_updated` integer DEFAULT 0 NOT NULL,
	`rows_unchanged` integer DEFAULT 0 NOT NULL,
	`rows_missing_from_source` integer DEFAULT 0 NOT NULL,
	`issue_count` integer DEFAULT 0 NOT NULL,
	`error` text,
	FOREIGN KEY (`source_id`) REFERENCES `ref_data_source`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ref_ingestion_job_dataset_idx` ON `ref_ingestion_job` (`dataset`,`id`);--> statement-breakpoint
CREATE TABLE `ref_location` (
	`id` text PRIMARY KEY NOT NULL,
	`dataset` text NOT NULL,
	`source_id` text NOT NULL,
	`source_key` text NOT NULL,
	`job_id` integer NOT NULL,
	`confidence` text NOT NULL,
	`verification` text NOT NULL,
	`content_hash` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`elevation_m` real,
	`country_iso2` text,
	`region_code` text,
	`municipality` text,
	`ident` text,
	`icao` text,
	`iata` text,
	`scheduled_service` integer,
	`population` integer,
	FOREIGN KEY (`source_id`) REFERENCES `ref_data_source`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `ref_ingestion_job`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`country_iso2`) REFERENCES `ref_country`(`iso2`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ref_location_lat_range" CHECK("ref_location"."lat" between -90 and 90),
	CONSTRAINT "ref_location_lon_range" CHECK("ref_location"."lon" between -180 and 180)
);
--> statement-breakpoint
CREATE INDEX `ref_location_kind_idx` ON `ref_location` (`kind`);--> statement-breakpoint
CREATE INDEX `ref_location_country_idx` ON `ref_location` (`country_iso2`);--> statement-breakpoint
CREATE INDEX `ref_location_icao_idx` ON `ref_location` (`icao`);--> statement-breakpoint
CREATE INDEX `ref_location_iata_idx` ON `ref_location` (`iata`);--> statement-breakpoint
CREATE TABLE `ref_runway` (
	`id` text PRIMARY KEY NOT NULL,
	`dataset` text NOT NULL,
	`source_id` text NOT NULL,
	`source_key` text NOT NULL,
	`job_id` integer NOT NULL,
	`confidence` text NOT NULL,
	`verification` text NOT NULL,
	`content_hash` text NOT NULL,
	`location_id` text NOT NULL,
	`length_m` real,
	`width_m` real,
	`surface` text,
	`lighted` integer NOT NULL,
	`closed` integer NOT NULL,
	`low_end_ident` text,
	`high_end_ident` text,
	`low_end_heading_deg` real,
	`high_end_heading_deg` real,
	FOREIGN KEY (`source_id`) REFERENCES `ref_data_source`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `ref_ingestion_job`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `ref_location`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ref_runway_location_idx` ON `ref_runway` (`location_id`);