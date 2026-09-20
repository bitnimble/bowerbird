-- CREATE TRIGGER IF NOT EXISTS never replaces a body; drop by name so triggers() re-creates it
-- with the widened allowlist (photoInputTriggers, triggers.ts:24).
DROP TRIGGER IF EXISTS photos_index_inputs_ins;
--> statement-breakpoint
DROP TRIGGER IF EXISTS photos_index_inputs_upd;
