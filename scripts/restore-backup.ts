// Put a catalogue backup back (§4.9). Stop the server first - it holds the file
// this replaces - though that is enforced rather than asked for: a restore under a
// running server is refused.
//
//   bun run restore              # list what there is
//   bun run restore <file>       # restore that one, by the name listed or by path
//   bun run restore latest       # restore the newest
//
// `DB_PATH` says which catalogue, the same as it does for the server. Nothing is
// deleted: the catalogue that was there is moved aside, sidecars and all, so a
// restore chosen in a panic can itself be undone.
import path from 'node:path';
import { config } from '../src/config';
import { findBackup, listBackups } from '../src/services/maintenance/backup_service';
import { restoreBackup } from '../src/services/maintenance/restore';
import { backupsDir } from '../src/utils/paths';

const [, , requested] = process.argv;
const dir = backupsDir(config.dbPath);

// Everything is inside the handler, listing included. Each refusal here is one
// somebody is meant to read and act on - a backup from a newer build, a file that
// is not intact, a directory that cannot be read - and a stack trace is not that.
// The listing throws rather than reporting an empty directory it could not read,
// which is the whole reason it must be caught somewhere.
try {
  if (requested == null) {
    const backups = await listBackups(config.dbPath);
    console.log(`Catalogue: ${config.dbPath}`);
    console.log(backups.length === 0 ? `No backups in ${dir}` : `Backups in ${dir}:`);
    for (const file of backups) console.log(`  ${path.basename(file)}`);
    console.log('\nRestore one with: bun run restore <file|latest>');
    process.exit(0);
  }

  const chosen = await findBackup(config.dbPath, requested);
  if (chosen == null) {
    console.error(`No such backup: ${requested}. Run it with no arguments to see what there is.`);
    process.exit(1);
  }

  const { movedAside, version, restamped } = await restoreBackup(config.dbPath, chosen);
  console.log(`Restored ${chosen} to ${config.dbPath} (schema ${version}).`);
  if (movedAside != null) console.log(`The catalogue that was there is at ${movedAside}; delete it once you are happy.`);
  if (restamped > 0) {
    console.log(
      `This library replicates, so ${restamped} row(s) were re-stamped: what you restored is what the ` +
        'other devices will take. Photographs they hold and this backup does not still arrive as usual.',
    );
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
