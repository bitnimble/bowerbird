ALTER TABLE `shoots` ADD `stamp_folder` text;--> statement-breakpoint
-- Seeded from the shoot's own stamp, which is what covered `folder_path` until now: left NULL, a
-- folder that was renamed before this upgrade would stop travelling, and every such shoot would read
-- as the weaker claim the first time two peers contested a folder.
UPDATE `shoots` SET `stamp_folder` = `stamp` WHERE `stamp` IS NOT NULL;