ALTER TABLE `libraries` ADD `render_skip_full` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `libraries` ADD `render_skip_max` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE `render_timings` (
	`library_id` text NOT NULL,
	`rendition` text NOT NULL,
	`total_ms` real NOT NULL,
	`stages_ms` text NOT NULL,
	`measured_at` text NOT NULL,
	PRIMARY KEY(`library_id`, `rendition`),
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "render_timings_rendition" CHECK("render_timings"."rendition" IN ('full','max'))
);
