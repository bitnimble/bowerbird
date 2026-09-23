ALTER TABLE `photos` ADD `capture_sequence` text;
--> statement-breakpoint
CREATE TABLE `__new_stacks` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`origin` text NOT NULL,
	`date_created` text NOT NULL,
	`stamp` text,
	`created_stamp` text,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stacks_origin" CHECK("__new_stacks"."origin" IN ('auto', 'manual', 'bracket'))
);
--> statement-breakpoint
INSERT INTO `__new_stacks` (`id`, `library_id`, `origin`, `date_created`, `stamp`, `created_stamp`)
	SELECT `id`, `library_id`, `origin`, `date_created`, `stamp`, `created_stamp` FROM `stacks`;
--> statement-breakpoint
DROP TABLE `stacks`;
--> statement-breakpoint
ALTER TABLE `__new_stacks` RENAME TO `stacks`;
--> statement-breakpoint
CREATE INDEX `idx_stacks_library` ON `stacks` (`library_id`);
