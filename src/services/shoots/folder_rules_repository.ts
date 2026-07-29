import type { Database } from 'bun:sqlite';
import type { FolderRule, FolderRuleKind } from '../../schemas/libraries';

// Where a folder differs from what the library's own settings say (DESIGN §4.7).
export class FolderRulesRepository {
  constructor(private readonly db: Database) {}

  listByLibrary(libraryId: string): FolderRule[] {
    return this.db
      .query('SELECT folder_path, rule FROM folder_rules WHERE library_id = ? ORDER BY folder_path')
      .all(libraryId) as FolderRule[];
  }

  pathsWithRule(libraryId: string, rule: FolderRuleKind): Set<string> {
    const rows = this.db
      .query('SELECT folder_path FROM folder_rules WHERE library_id = ? AND rule = ?')
      .all(libraryId, rule) as { folder_path: string }[];
    return new Set(rows.map((r) => r.folder_path));
  }

  // One rule per folder: 'excluded' and 'plain' answer the same question about it,
  // so setting one replaces the other rather than stacking with it.
  set(libraryId: string, folderPath: string, rule: FolderRuleKind): void {
    this.db
      .query(
        `INSERT INTO folder_rules (library_id, folder_path, rule) VALUES (?, ?, ?)
           ON CONFLICT(library_id, folder_path) DO UPDATE SET rule = excluded.rule`,
      )
      .run(libraryId, folderPath, rule);
  }

  clear(libraryId: string, folderPath: string): boolean {
    return this.db.query('DELETE FROM folder_rules WHERE library_id = ? AND folder_path = ?').run(libraryId, folderPath)
      .changes > 0;
  }
}
