// Takes one snapshot of the catalogue and verifies it (§4.9).
//
// On a thread of its own because the driver is synchronous: `VACUUM INTO` on the
// server's connection would hold the event loop for the whole copy, which on a
// large catalogue is seconds of a server that answers nothing. It only needs a
// read transaction, so it blocks no writer.
import { Database } from '../../db/driver';
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

// What a snapshot costs, and it is not `stat(dbPath).size`: committed work sits in
// the `-wal` until a checkpoint moves it, and a long-lived reader - which the
// backup itself is - stops checkpoints advancing. Measured, a 220KB main file
// beside a 56MB WAL vacuumed to 46MB, 200x what the main file alone suggested.
//
// The larger of the two rather than their sum, because a checkpoint-starved WAL is
// mostly *rewrites of pages already in the main file* - measured 15.7MB beside a
// 15.7MB main file for a 15.7MB result, where adding them would demand three times
// what the snapshot actually takes and refuse backups that had room. Half again on
// top, because a guard against filling the disk that leaves no margin is a guard
// that passes and then fills the disk.
//
// Against the backup directory rather than the database's, which can be a different
// volume even though the shipped compose file puts both on `/config`.
export function spaceNeededFor(mainBytes: number, walBytes: number): number {
  return Math.ceil(Math.max(mainBytes, walBytes) * 1.5);
}

async function requireSpaceFor(job: BackupJob): Promise<void> {
  const main = await stat(job.dbPath);
  const wal = await stat(`${job.dbPath}-wal`).then((s) => s.size, () => 0);
  const needed = spaceNeededFor(main.size, wal);
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

async function run(job: BackupJob): Promise<{ bytes: number }> {
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
  return { bytes: (await stat(job.outPath)).size };
}

// A part-written file is left for the caller to remove: it has to handle the case
// where this thread dies without reporting anyway, so cleaning up here as well
// would be two owners for one file.
//
// Guarded so the module can be imported from the main thread - which is only for
// the pure helper above, and is what lets it be tested without a worker at all.
if (typeof self !== 'undefined') {
  self.onmessage = async (event) => {
    try {
      self.postMessage(await run(event.data));
    } catch (error) {
      self.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
  };
}
