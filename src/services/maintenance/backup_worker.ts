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
export type BackupOutcome = { bytes: number } | { error: string };

declare const self: {
  onmessage: ((event: MessageEvent<BackupJob>) => void) | null;
  postMessage: (message: BackupOutcome) => void;
};

function userVersion(db: Database): number {
  return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
}

// A snapshot costs about what the catalogue costs, and running out halfway leaves
// a partial file occupying the space the next attempt needs. Measured against the
// backup directory rather than the database's: they can be different volumes.
async function requireSpaceFor(job: BackupJob): Promise<void> {
  const { size } = await stat(job.dbPath);
  const { bavail, bsize } = await statfs(path.dirname(job.outPath));
  const free = bavail * bsize;
  if (free < size) throw new Error(`not enough space: needs ~${size} bytes, ${free} free`);
}

// Cheap, and the only thing standing between a backup that was never readable and
// discovering that at restore time. `user_version` as well as the integrity check,
// because a copy of the wrong database would pass the latter.
function verify(outPath: string, expectedVersion: number): void {
  const copy = new Database(outPath, { readonly: true });
  try {
    const { quick_check: result } = copy.query('PRAGMA quick_check').get() as { quick_check: string };
    if (result !== 'ok') throw new Error(`quick_check says ${result}`);
    const version = userVersion(copy);
    if (version !== expectedVersion) throw new Error(`user_version is ${version}, expected ${expectedVersion}`);
  } finally {
    copy.close();
  }
}

async function run(job: BackupJob): Promise<number> {
  await requireSpaceFor(job);
  // `VACUUM INTO` rather than a file copy: it reads a consistent snapshot inside a
  // read transaction, and produces one self-contained file with no -wal beside it
  // that a restore would have to remember to bring along.
  const source = new Database(job.dbPath, { readonly: true });
  try {
    source.exec('PRAGMA busy_timeout = 5000;');
    source.run('VACUUM INTO ?', [job.outPath]);
    verify(job.outPath, userVersion(source));
  } finally {
    source.close();
  }
  return (await stat(job.outPath)).size;
}

// A part-written file is left for the caller to remove: it has to handle the case
// where this thread dies without reporting anyway, so cleaning up here as well
// would be two owners for one file.
self.onmessage = async (event) => {
  try {
    self.postMessage({ bytes: await run(event.data) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
