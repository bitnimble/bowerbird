CREATE TABLE `photo_links` (
	`library_id` text NOT NULL,
	`raw_id` text NOT NULL,
	`camera_file_id` text NOT NULL,
	`pending` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`raw_id`, `camera_file_id`),
	FOREIGN KEY (`raw_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`camera_file_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_photo_links_camera_file` ON `photo_links` (`camera_file_id`);
--> statement-breakpoint
CREATE INDEX `idx_photo_links_pending` ON `photo_links` (`pending`) WHERE `pending` = 1;
