CREATE TABLE `ref_pack_install` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`manifest_sha256` text NOT NULL,
	`format_version` integer NOT NULL,
	`pipeline_version` integer NOT NULL,
	`dataset_count` integer NOT NULL,
	`row_count` integer NOT NULL,
	`installed_wall_ms` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `ref_runway` ADD `low_end_lat` real;--> statement-breakpoint
ALTER TABLE `ref_runway` ADD `low_end_lon` real;--> statement-breakpoint
ALTER TABLE `ref_runway` ADD `high_end_lat` real;--> statement-breakpoint
ALTER TABLE `ref_runway` ADD `high_end_lon` real;