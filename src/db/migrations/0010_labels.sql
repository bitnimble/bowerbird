CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`name` text NOT NULL,
	`colour` text NOT NULL,
	`position` integer NOT NULL,
	`stamp` text,
	`stamp_position` text,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_labels_library` ON `labels` (`library_id`);--> statement-breakpoint
CREATE TABLE `photo_labels` (
	`library_id` text NOT NULL,
	`label_id` text NOT NULL,
	`photo_id` text NOT NULL,
	`stamp` text,
	PRIMARY KEY(`library_id`, `label_id`, `photo_id`),
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_photo_labels_photo` ON `photo_labels` (`photo_id`,`label_id`);
