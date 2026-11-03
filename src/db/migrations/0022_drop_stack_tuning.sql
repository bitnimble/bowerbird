-- The likeness threshold and window are constants in `stacks_service.ts`. A value an older peer still
-- sends for either is ignored: apply reads only the columns of its own units.
ALTER TABLE `libraries` DROP COLUMN `auto_stack_similarity`;
--> statement-breakpoint
ALTER TABLE `libraries` DROP COLUMN `auto_stack_window_seconds`;
