ALTER TABLE `renditions` ADD `used_at` text;
--> statement-breakpoint
CREATE INDEX `idx_renditions_used` ON `renditions` (`used_at`) WHERE `used_at` IS NOT NULL AND `variant` != 'grid';
