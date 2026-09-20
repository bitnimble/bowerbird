CREATE TABLE `backup_locations` (
	`library_id` text NOT NULL,
	`photo_id` text NOT NULL,
	`peer_id` text NOT NULL,
	`rel_path` text NOT NULL,
	`content_hash` text NOT NULL,
	`size` integer NOT NULL,
	`verified_at` text NOT NULL,
	PRIMARY KEY(`library_id`, `photo_id`, `peer_id`),
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `__new_replication_peers` (
	`library_id` text NOT NULL,
	`peer_id` text NOT NULL,
	`name` text NOT NULL,
	`paired_at` text NOT NULL,
	`last_replicated_at` text,
	`kind` text DEFAULT 'active' NOT NULL,
	`address` text,
	`last_error` text,
	`wants_originals` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`library_id`, `peer_id`),
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "replication_peers_kind" CHECK("__new_replication_peers"."kind" IN ('active', 'passive'))
);
--> statement-breakpoint
INSERT INTO `__new_replication_peers`
	(`library_id`, `peer_id`, `name`, `paired_at`, `last_replicated_at`, `address`, `last_error`, `wants_originals`)
	SELECT `library_id`, `peer_id`, `name`, `paired_at`, `last_replicated_at`, `address`, `last_error`, `wants_originals`
	FROM `replication_peers`;
--> statement-breakpoint
DROP TABLE `replication_peers`;
--> statement-breakpoint
ALTER TABLE `__new_replication_peers` RENAME TO `replication_peers`;
--> statement-breakpoint
ALTER TABLE `replication_libraries` ADD `local_budget_bytes` integer;
--> statement-breakpoint
ALTER TABLE `photos` ADD `last_accessed_at` text;
