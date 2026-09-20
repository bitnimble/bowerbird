ALTER TABLE `photos` ADD `is_hidden` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `photos` ADD `stamp_hidden` text;--> statement-breakpoint
CREATE INDEX `idx_photos_is_hidden` ON `photos` (`library_id`,`is_hidden`) WHERE "photos"."is_hidden" = 1;--> statement-breakpoint
ALTER TABLE `shoots` ADD `is_hidden` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `shoots` ADD `stamp_hidden` text;--> statement-breakpoint
CREATE INDEX `idx_shoots_hidden` ON `shoots` (`is_hidden`) WHERE "shoots"."is_hidden" = 1;