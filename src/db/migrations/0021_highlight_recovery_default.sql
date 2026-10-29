-- Highlight recovery's default moved from 100 to 50, and every edit left at 100 moves with it; the
-- undo histories are rewritten by `highlightRecoveryHistories` in migrate.ts. CASE, not AND: SQLite
-- may evaluate json_extract first, and one malformed doc would then abort every launch.
UPDATE `photo_edits` SET `doc` = json_set(`doc`, '$.highlightRecovery', 50)
  WHERE CASE WHEN json_valid(`doc`) THEN json_extract(`doc`, '$.highlightRecovery') END = 100;
--> statement-breakpoint
UPDATE `edit_conflicts` SET `doc` = json_set(`doc`, '$.highlightRecovery', 50)
  WHERE CASE WHEN json_valid(`doc`) THEN json_extract(`doc`, '$.highlightRecovery') END = 100;
