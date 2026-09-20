CREATE TABLE `album_banners` (
	`album_id` text PRIMARY KEY NOT NULL,
	`photo_id` text NOT NULL,
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_album_banners_photo` ON `album_banners` (`photo_id`);--> statement-breakpoint
CREATE TABLE `album_photos` (
	`album_id` text NOT NULL,
	`photo_id` text NOT NULL,
	`date_added` text NOT NULL,
	PRIMARY KEY(`album_id`, `photo_id`),
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_album_photos_photo` ON `album_photos` (`photo_id`);--> statement-breakpoint
CREATE TABLE `albums` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`ordering` text DEFAULT 'taken_asc' NOT NULL,
	CONSTRAINT "albums_ordering" CHECK("albums"."ordering" IN ('taken_asc', 'taken_desc', 'added_asc', 'added_desc'))
);
--> statement-breakpoint
CREATE TABLE `blob_locations` (
	`library_id` text NOT NULL,
	`photo_id` text NOT NULL,
	`peer_id` text NOT NULL,
	`stamp` text NOT NULL,
	PRIMARY KEY(`library_id`, `photo_id`, `peer_id`)
);
--> statement-breakpoint
CREATE TABLE `blob_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`photo_id` text NOT NULL,
	`peer_id` text NOT NULL,
	`direction` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`bytes_done` integer DEFAULT 0 NOT NULL,
	`bytes_total` integer,
	`error` text,
	`queued_at` text NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "blob_transfers_direction" CHECK("blob_transfers"."direction" IN ('push', 'pull')),
	CONSTRAINT "blob_transfers_state" CHECK("blob_transfers"."state" IN ('queued', 'active', 'paused', 'done', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blob_transfers_library_id_photo_id_peer_id_direction_unique` ON `blob_transfers` (`library_id`,`photo_id`,`peer_id`,`direction`);--> statement-breakpoint
CREATE TABLE `exports` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`photo_id` text NOT NULL,
	`source_path` text NOT NULL,
	`output_path` text,
	`edits` text,
	`thumbnail` blob,
	`exported_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_exports_when` ON `exports` ("exported_at" desc);--> statement-breakpoint
CREATE INDEX `idx_exports_run` ON `exports` (`run_id`);--> statement-breakpoint
CREATE TABLE `folder_rules` (
	`library_id` text NOT NULL,
	`folder_path` text NOT NULL,
	`rule` text NOT NULL,
	`stamp` text,
	PRIMARY KEY(`library_id`, `folder_path`),
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "folder_rules_rule" CHECK("folder_rules"."rule" IN ('excluded', 'plain'))
);
--> statement-breakpoint
CREATE TABLE `libraries` (
	`id` text PRIMARY KEY NOT NULL,
	`root_path` text NOT NULL,
	`name` text NOT NULL,
	`last_synced_at` text,
	`ordering` text DEFAULT 'taken_asc' NOT NULL,
	`rendition_source` text DEFAULT 'render' NOT NULL,
	`rendition_hdr` integer DEFAULT 1 NOT NULL,
	`include_subfolders` integer DEFAULT 1 NOT NULL,
	`mirror_shoots` integer DEFAULT 1 NOT NULL,
	`include_non_raw` integer DEFAULT 0 NOT NULL,
	`bin_name` text,
	`read_only` integer DEFAULT 0 NOT NULL,
	`bin_dev` integer,
	`bin_ino` integer,
	`bin_birthtime` real,
	`auto_stack` integer DEFAULT 1 NOT NULL,
	`auto_stack_similarity` real DEFAULT 0.78 NOT NULL,
	`auto_stack_window_seconds` integer DEFAULT 60 NOT NULL,
	`stamp` text,
	CONSTRAINT "libraries_ordering" CHECK("libraries"."ordering" IN ('taken_asc', 'taken_desc', 'added_asc', 'added_desc')),
	CONSTRAINT "libraries_rendition_source" CHECK("libraries"."rendition_source" IN ('embedded', 'render'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `libraries_root_path_unique` ON `libraries` (`root_path`);--> statement-breakpoint
CREATE TABLE `sync_locks` (
	`library_id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`started_at` text NOT NULL,
	`refreshed_at` text NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `edit_conflicts` (
	`photo_id` text NOT NULL,
	`session_id` text NOT NULL,
	`doc` text NOT NULL,
	`history` text,
	`cursor` integer NOT NULL,
	`chain` text NOT NULL,
	`stamp` text,
	PRIMARY KEY(`photo_id`, `session_id`),
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `photo_edit_history` (
	`photo_id` text PRIMARY KEY NOT NULL,
	`deltas` text NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `photo_edits` (
	`photo_id` text PRIMARY KEY NOT NULL,
	`doc` text NOT NULL,
	`cursor` integer NOT NULL,
	`rev` integer NOT NULL,
	`updated_at` text NOT NULL,
	`stamp` text,
	`session_id` text,
	`chain` text,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `photo_inputs` (
	`library_id` text NOT NULL,
	`photo_id` text NOT NULL,
	`path` text NOT NULL,
	PRIMARY KEY(`photo_id`, `path`),
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_photo_inputs_path` ON `photo_inputs` (`library_id`,`path`);--> statement-breakpoint
CREATE TABLE `photo_sources` (
	`library_id` text NOT NULL,
	`composed_id` text NOT NULL,
	`photo_id` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`composed_id`, `photo_id`),
	FOREIGN KEY (`composed_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_photo_sources_photo` ON `photo_sources` (`photo_id`);--> statement-breakpoint
CREATE TABLE `photos` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`shoot_id` text,
	`file_hash` text,
	`format` text,
	`file_size` integer,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`orientation` integer DEFAULT 0 NOT NULL,
	`is_missing` integer DEFAULT 0 NOT NULL,
	`is_deleted` integer DEFAULT 0 NOT NULL,
	`date_taken` text,
	`date_taken_offset` text,
	`date_added` text NOT NULL,
	`date_updated` text,
	`processing_error` text,
	`latitude` real,
	`longitude` real,
	`iso` integer,
	`shutter_speed` real,
	`aperture` real,
	`focal_length` real,
	`camera_make` text,
	`camera_model` text,
	`lens_model` text,
	`deleted_from_path` text,
	`deleted_batch` text,
	`rating` integer DEFAULT 0 NOT NULL,
	`triage` text,
	`notes` text,
	`rendition_source` text,
	`recipe` text NOT NULL,
	`viewer_rendition` text,
	`stack_id` text,
	`stack_state` text DEFAULT 'none' NOT NULL,
	`descriptor` blob,
	`is_representative` integer DEFAULT 1 NOT NULL,
	`stamp_imported` text,
	`stamp_triage` text,
	`stamp_placement` text,
	`stamp_bin` text,
	`stamp_stack` text,
	`content_hash` text,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shoot_id`) REFERENCES `shoots`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "photos_rating" CHECK("photos"."rating" >= 0 AND "photos"."rating" <= 5),
	CONSTRAINT "photos_triage" CHECK("photos"."triage" IN ('picked', 'rejected')),
	CONSTRAINT "photos_rendition_source" CHECK("photos"."rendition_source" IN ('embedded', 'render')),
	CONSTRAINT "photos_stack_state" CHECK("photos"."stack_state" IN ('none', 'stacked', 'unstacked'))
);
--> statement-breakpoint
CREATE INDEX `idx_photos_library` ON `photos` (`library_id`);--> statement-breakpoint
CREATE INDEX `idx_photos_shoot` ON `photos` (`shoot_id`);--> statement-breakpoint
CREATE INDEX `idx_photos_library_order_added` ON `photos` (`library_id`,`is_deleted`,`date_added`,`id`);--> statement-breakpoint
CREATE INDEX `idx_photos_library_order_taken` ON `photos` (`library_id`,`is_deleted`,("date_taken" IS NULL),`date_taken`,`id`);--> statement-breakpoint
CREATE INDEX `idx_photos_shoot_order_added` ON `photos` (`shoot_id`,`is_deleted`,`date_added`,`id`);--> statement-breakpoint
CREATE INDEX `idx_photos_shoot_order_taken` ON `photos` (`shoot_id`,`is_deleted`,("date_taken" IS NULL),`date_taken`,`id`);--> statement-breakpoint
CREATE INDEX `idx_photos_library_order_taken_desc` ON `photos` (`library_id`,`is_deleted`,("date_taken" IS NULL),"date_taken" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `idx_photos_shoot_order_taken_desc` ON `photos` (`shoot_id`,`is_deleted`,("date_taken" IS NULL),"date_taken" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `idx_photos_file_hash` ON `photos` (`library_id`,`file_hash`);--> statement-breakpoint
CREATE INDEX `idx_photos_is_missing` ON `photos` (`library_id`,`is_missing`) WHERE "photos"."is_missing" = 1;--> statement-breakpoint
CREATE INDEX `idx_photos_is_deleted` ON `photos` (`library_id`,`is_deleted`) WHERE "photos"."is_deleted" = 1;--> statement-breakpoint
CREATE INDEX `idx_photos_deleted_batch` ON `photos` (`deleted_batch`) WHERE "photos"."deleted_batch" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_photos_stack` ON `photos` (`stack_id`);--> statement-breakpoint
CREATE INDEX `idx_photos_stack_candidates` ON `photos` (`library_id`,`stack_state`,`date_taken`,`date_added`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_photos_one_representative` ON `photos` (`stack_id`) WHERE "photos"."stack_id" IS NOT NULL AND "photos"."is_representative" = 1;--> statement-breakpoint
CREATE TABLE `fetched_renditions` (
	`library_id` text NOT NULL,
	`photo_id` text NOT NULL,
	`rendition` text NOT NULL,
	`hdr` integer NOT NULL,
	`bytes` integer NOT NULL,
	`used_at` text NOT NULL,
	PRIMARY KEY(`library_id`, `photo_id`, `rendition`, `hdr`),
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fetched_renditions_used` ON `fetched_renditions` (`library_id`,`used_at`);--> statement-breakpoint
CREATE TABLE `renditions` (
	`photo_id` text NOT NULL,
	`variant` text NOT NULL,
	`needs_build` integer DEFAULT 0 NOT NULL,
	`built_at` text,
	`built_from` text,
	`source` text,
	`matched` integer,
	PRIMARY KEY(`photo_id`, `variant`),
	CONSTRAINT "renditions_source" CHECK("renditions"."source" IN ('embedded', 'render'))
);
--> statement-breakpoint
CREATE INDEX `idx_renditions_owed` ON `renditions` (`variant`) WHERE "renditions"."needs_build" = 1;--> statement-breakpoint
CREATE TABLE `materialisation_flags` (
	`library_id` text NOT NULL,
	`photo_id` text NOT NULL,
	`target_path` text NOT NULL,
	`reason` text NOT NULL,
	PRIMARY KEY(`library_id`, `photo_id`),
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `materialisation_queue` (
	`library_id` text NOT NULL,
	`photo_id` text NOT NULL,
	`was_at` text NOT NULL,
	PRIMARY KEY(`library_id`, `photo_id`),
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `replication_identity` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`peer_id` text NOT NULL,
	`name` text NOT NULL,
	CONSTRAINT "replication_identity_singleton" CHECK("replication_identity"."singleton" = 1)
);
--> statement-breakpoint
CREATE TABLE `replication_libraries` (
	`library_id` text PRIMARY KEY NOT NULL,
	`sync_originals` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `replication_log` (
	`library_id` text NOT NULL,
	`entity` text NOT NULL,
	`row_id` text NOT NULL,
	`stamp` text NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`library_id`, `entity`, `row_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_replication_log_stamp` ON `replication_log` (`library_id`,`stamp`);--> statement-breakpoint
CREATE TABLE `replication_peer_vectors` (
	`library_id` text NOT NULL,
	`peer_id` text NOT NULL,
	`origin` text NOT NULL,
	`stamp` text NOT NULL,
	PRIMARY KEY(`library_id`, `peer_id`, `origin`)
);
--> statement-breakpoint
CREATE TABLE `replication_peers` (
	`library_id` text NOT NULL,
	`peer_id` text NOT NULL,
	`name` text NOT NULL,
	`paired_at` text NOT NULL,
	`last_replicated_at` text,
	`address` text,
	`last_error` text,
	`wants_originals` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`library_id`, `peer_id`),
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `replication_vectors` (
	`library_id` text NOT NULL,
	`origin` text NOT NULL,
	`stamp` text NOT NULL,
	PRIMARY KEY(`library_id`, `origin`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `shoot_banners` (
	`shoot_id` text PRIMARY KEY NOT NULL,
	`photo_id` text NOT NULL,
	`stamp` text,
	FOREIGN KEY (`shoot_id`) REFERENCES `shoots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_shoot_banners_photo` ON `shoot_banners` (`photo_id`);--> statement-breakpoint
CREATE TABLE `shoots` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`library_id` text NOT NULL,
	`folder_path` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`ordering` text DEFAULT 'taken_asc' NOT NULL,
	`folder_dev` integer,
	`folder_ino` integer,
	`folder_birthtime` real,
	`stamp` text,
	FOREIGN KEY (`parent_id`) REFERENCES `shoots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "shoots_ordering" CHECK("shoots"."ordering" IN ('taken_asc', 'taken_desc', 'added_asc', 'added_desc'))
);
--> statement-breakpoint
CREATE INDEX `idx_shoots_library` ON `shoots` (`library_id`);--> statement-breakpoint
CREATE INDEX `idx_shoots_parent` ON `shoots` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_shoots_identity` ON `shoots` (`library_id`,`folder_path`,`id`,`folder_dev`,`folder_ino`,`folder_birthtime`);--> statement-breakpoint
CREATE UNIQUE INDEX `shoots_library_id_folder_path_unique` ON `shoots` (`library_id`,`folder_path`);--> statement-breakpoint
CREATE TABLE `stack_members` (
	`library_id` text NOT NULL,
	`stack_id` text NOT NULL,
	`photo_id` text NOT NULL,
	`stamp` text,
	PRIMARY KEY(`library_id`, `stack_id`, `photo_id`),
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_stack_members_photo` ON `stack_members` (`photo_id`);--> statement-breakpoint
CREATE TABLE `stacks` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`origin` text NOT NULL,
	`date_created` text NOT NULL,
	`stamp` text,
	`created_stamp` text,
	FOREIGN KEY (`library_id`) REFERENCES `libraries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stacks_origin" CHECK("stacks"."origin" IN ('auto', 'manual'))
);
--> statement-breakpoint
CREATE INDEX `idx_stacks_library` ON `stacks` (`library_id`);