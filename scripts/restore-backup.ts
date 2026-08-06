// Put a catalogue backup back (§4.9). Stop the server first: it holds the file
// this replaces, and a running one would keep writing to the catalogue being
// moved aside.
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
import { backupsDir, findBackup, listBackups } from '../src/services/maintenance/backup_service';
import { restoreBackup } from '../src/services/maintenance/restore';

const [, , requested] = process.argv;
const dir = backupsDir(config.dbPath);
const backups = await listBackups(config.dbPath);

if (requested == null) {
  console.log(`Catalogue: ${config.dbPath}`);
  console.log(backups.length === 0 ? `No backups in ${dir}` : `Backups in ${dir}:`);
  for (const file of backups) console.log(`  ${path.basename(file)}`);
  console.log('\nRestore one with: bun run restore <file|latest>');
  process.exit(0);
}

const chosen = await findBackup(config.dbPath, requested);
if (chosen == null) {
  console.error(backups.length === 0 ? `No backups in ${dir}` : `No such backup: ${requested}`);
  process.exit(1);
}

const { movedAside, version } = await restoreBackup(config.dbPath, chosen);
console.log(`Restored ${chosen} to ${config.dbPath} (schema ${version}).`);
if (movedAside != null) console.log(`The catalogue that was there is at ${movedAside}; delete it once you are happy.`);
