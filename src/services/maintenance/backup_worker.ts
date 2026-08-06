// Takes one snapshot of the catalogue and verifies it (§4.9).
//
// On a thread of its own because bun:sqlite is synchronous: `VACUUM INTO` on the
// server's connection would hold the event loop for the whole copy, which on a
// large catalogue is seconds of a server that answers nothing. It only needs a
// read transaction, so it blocks no writer.
import { Database } from 'bun:sqlite';
import { stat, statfs } from 'node:fs/promises';
import path from 'node:path';

export interface BackupJob {
  dbPath: string;
  /** Where to write. Must not exist: `VACUUM INTO` refuses an existing file. */
  outPath: string;
}
/**
 * `libraries` is how many the snapshot holds, read back out of the finished file.
 * Rotation needs it to tell a snapshot of the catalogue from a snapshot of a
 * *replacement* for it (§4.9).
 */
export type BackupOutcome = { bytes: number; libraries: number } | { error: string };

declare const self: {
  onmessage: ((event: MessageEvent<BackupJob>) => void) | null;
  postMessage: (message: BackupOutcome) => void;
};

function userVersion(db: Database): number {
  return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
}

// What a snapshot costs, and it is not `stat(dbPath).size`: committed work sits in
// the `-wal` until a checkpoint moves it, and a long-lived reader - which the
// backup itself is - stops checkpoints advancing. Measured, a 220KB main file
// beside a 56MB WAL vacuumed to 46MB, 200x what the main file alone suggested. Half
// again on top, because a guard against filling the disk that leaves no margin is
// a guard that passes and then fills the disk.
//
// Against the backup directory rather than the database's: they can be different
// volumes, and in the shipped container they are.
async function requireSpaceFor(job: BackupJob): Promise<void> {
  const main = await stat(job.dbPath);
  const wal = await stat(`${job.dbPath}-wal`).then((s) => s.size, () => 0);
  const needed = Math.ceil((main.size + wal) * 1.5);
  const { bavail, bsize } = await statfs(path.dirname(job.outPath));
  const free = bavail * bsize;
  if (free < needed) throw new Error(`not enough space: needs ~${needed} bytes, ${free} free`);
}

// Reads the finished snapshot back. `quick_check` is what catches a copy that was
// never readable, which is otherwise only discovered at restore time.
//
// The `user_version` comparison is an invariant assertion rather than a check that
// can fail in practice: the expected value comes from the connection that just
// produced the file. It is kept because `VACUUM INTO` silently preserving
// `user_version` is the property the restore-side version refusal rests on, and a
// SQLite that stopped doing that should be loud here rather than at a restore.
function verify(outPath: string, expectedVersion: number): number {
  const copy = new Database(outPath, { readonly: true });
  try {
    const { quick_check: result } = copy.query('PRAGMA quick_check').get() as { quick_check: string };
    if (result !== 'ok') throw new Error(`quick_check says ${result}`);
    const version = userVersion(copy);
    if (version !== expectedVersion) throw new Error(`user_version is ${version}, expected ${expectedVersion}`);
    return (copy.query('SELECT count(*) AS n FROM libraries').get() as { n: number }).n;
  } finally {
    copy.close();
  }
}

async function run(job: BackupJob): Promise<{ bytes: number; libraries: number }> {
  await requireSpaceFor(job);
  // `VACUUM INTO` rather than a file copy: it reads a consistent snapshot inside a
  // read transaction, and produces one self-contained file with no -wal beside it
  // that a restore would have to remember to bring along.
  const source = new Database(job.dbPath, { readonly: true });
  let libraries: number;
  try {
    source.exec('PRAGMA busy_timeout = 5000;');
    source.run('VACUUM INTO ?', [job.outPath]);
    libraries = verify(job.outPath, userVersion(source));
  } finally {
    source.close();
  }
  return { bytes: (await stat(job.outPath)).size, libraries };
}

// A part-written file is left for the caller to remove: it has to handle the case
// where this thread dies without reporting anyway, so cleaning up here as well
// would be two owners for one file.
self.onmessage = async (event) => {
  try {
    self.postMessage(await run(event.data));
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
