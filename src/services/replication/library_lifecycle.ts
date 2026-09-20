import type { Database } from '../../db/driver';
import type { Library } from '../../schemas/libraries';
import type { LibraryLifecycleListener } from '../libraries/libraries_service';
import { forgetLibrary } from './gc';

/**
 * Replication's own clean-up when a library goes (docs/replication.md §8.4).
 *
 * A listener rather than something `LibrariesService.delete` does itself, so the
 * knowledge of which replication tables exist stays in replication - the service
 * reaches the catalogue through repositories and holds no database handle.
 */
export class ReplicationLifecycle implements LibraryLifecycleListener {
  constructor(private readonly db: Database) {}

  onLibraryCreated(_library: Library): void {}

  onLibraryDeleted(libraryId: string): void {
    forgetLibrary(this.db, libraryId);
  }
}
