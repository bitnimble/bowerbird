import type { Database } from '../../db/driver';
import { BackupLocations } from '../backup/backup_locations';
import { Originals } from './originals';

/**
 * Originals for a device that holds its own: what is on disk is all there is, nothing is fetched,
 * and no access is recorded.
 *
 * For the suites about something else - a rendition, a listing, a composite - which need a
 * photograph's bytes to be findable and have nothing to say about where they came from. A suite
 * that is about the backup builds the real one over a real catalogue.
 */
export function localOriginals(): Originals {
  const inert = {
    query: () => ({ run: () => undefined, get: () => null, all: () => [] }),
  } as unknown as Database;
  return new Originals(
    inert,
    { getBasicById: () => null },
    {
      fetchOriginal: () => null,
      settled: () => {
        throw new Error('nothing is fetched here');
      },
    },
    new BackupLocations(inert),
  );
}
