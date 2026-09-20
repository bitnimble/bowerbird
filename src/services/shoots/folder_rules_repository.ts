import type { Database } from '../../db/driver';
import type { FolderRule, FolderRuleKind } from '../../schemas/libraries';
import { stamp } from '../replication/stamps';
import { tombstone } from '../replication/tombstones';

// Where a folder differs from what the library's own settings say (DESIGN §4.7).
//
// Writes are announced, the way `SettingsRepository` announces its own: an
// `excluded` rule is half of what the watcher decides which folders to watch by
// (§9.8), and it is written from three places - the settings page, and both
// halves of creating and deleting a shoot. A rule that only took effect after a
// restart would leave an excluded folder waking a sync on every change, and a
// folder rescued from exclusion unwatched until the daily full sync.
export class FolderRulesRepository {
  private readonly listeners: ((libraryId: string) => void)[] = [];

  constructor(private readonly db: Database) {}

  onChange(listener: (libraryId: string) => void): void {
    this.listeners.push(listener);
  }

  private announce(libraryId: string): void {
    for (const listener of this.listeners) listener(libraryId);
  }

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
        `INSERT INTO folder_rules (library_id, folder_path, rule, stamp) VALUES (?, ?, ?, ?)
           ON CONFLICT(library_id, folder_path) DO UPDATE SET rule = excluded.rule, stamp = excluded.stamp`,
      )
      .run(libraryId, folderPath, rule, stamp(this.db));
    this.announce(libraryId);
  }

  clear(libraryId: string, folderPath: string): boolean {
    const cleared =
      this.db.query('DELETE FROM folder_rules WHERE library_id = ? AND folder_path = ?').run(libraryId, folderPath).changes > 0;
    if (cleared) {
      tombstone(this.db, libraryId, 'folder_rule', folderPath, stamp(this.db));
      this.announce(libraryId);
    }
    return cleared;
  }
}
