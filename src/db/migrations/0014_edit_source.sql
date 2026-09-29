ALTER TABLE `photo_edits` ADD `source` text DEFAULT 'user' NOT NULL CHECK (`source` IN ('user', 'auto'));
