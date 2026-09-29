ALTER TABLE `backup_locations` RENAME COLUMN `verified_at` TO `checked_at`;
--> statement-breakpoint
ALTER TABLE `backup_locations` ADD `health` text DEFAULT 'held' NOT NULL CHECK (`health` IN ('held', 'missing', 'changed'));
--> statement-breakpoint
ALTER TABLE `backup_locations` ADD `current_issues` text DEFAULT '[]' NOT NULL CHECK (json_valid(`current_issues`) AND json_type(`current_issues`) = 'array' AND json_array_length(`current_issues`) <= 2);
--> statement-breakpoint
ALTER TABLE `replication_peers` ADD `last_backup_report` text;
--> statement-breakpoint
ALTER TABLE `replication_peers` ADD `last_restore_report` text;
--> statement-breakpoint
ALTER TABLE `blob_transfers` ADD `error_code` text;
