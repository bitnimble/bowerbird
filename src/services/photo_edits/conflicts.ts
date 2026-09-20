import type { Database } from '../../db/driver';
import { AppError } from '../../errors';
import { EditDocSchema, EditHistorySchema, type EditDoc } from '../../schemas/photo_edits';
import type { EditConflict } from '../../schemas/photo_edits';
import { stampMs, stampPeer } from '../replication/clock';
import { deviceName } from '../replication/pairing';
import { peerId, stamp } from '../replication/stamps';
import { tombstone } from '../replication/tombstones';
import type { PhotoEditsRepository } from './photo_edits_repository';

// The one merge a person is asked about (docs/replication.md §5.3), from the
// parked candidates to the choice that ends it.

interface Row {
  photo_id: string;
  session_id: string;
  doc: string;
  history: string | null;
  stamp: string;
  library_id: string;
  file_path: string | null;
}

// The path out of the recipe, and null for a row composed rather than imported: what names a
// conflict to a reader is a filename, and one that has none is named by nothing here.
const SELECT = `SELECT c.photo_id, c.session_id, c.doc, c.history, c.stamp, p.library_id,
                       json_extract(p.recipe, '$.path') AS file_path
                  FROM edit_conflicts c JOIN photos p ON p.id = c.photo_id`;

/** Every divergence still waiting on someone, newest first. */
export function listConflicts(db: Database, libraryId?: string): EditConflict[] {
  const rows = (
    libraryId == null
      ? db.query(`${SELECT} ORDER BY c.photo_id, c.stamp DESC`).all()
      : db.query(`${SELECT} WHERE p.library_id = ? ORDER BY c.photo_id, c.stamp DESC`).all(libraryId)
  ) as Row[];
  const self = peerId(db);
  const names = new Map<string, string>();
  return rows.map((row) => {
    const origin = stampPeer(row.stamp);
    if (!names.has(origin)) names.set(origin, origin === self ? deviceName(db) : peerNameOf(db, row.library_id, origin));
    return {
      photo_id: row.photo_id,
      library_id: row.library_id,
      file_path: row.file_path,
      session_id: row.session_id,
      device: names.get(origin) ?? origin,
      edited_at: new Date(stampMs(row.stamp)).toISOString(),
      edits: countEdits(row.history),
      doc: parseDoc(row.doc),
    };
  });
}

/**
 * Ends a divergence by taking one candidate's document.
 *
 * Branched from what the row holds *now* rather than written over it: edits may
 * have continued on the provisional winner since the conflict formed, and this
 * lands as an ordinary save in its own session, so what it replaces is in the
 * undo history rather than gone. The parked rows are then tombstoned, which is
 * what carries the resolution to the other peers.
 *
 * Answers with the library the photograph is in, which is what the divergence
 * having ended has to be announced against.
 */
export function resolveConflict(
  db: Database,
  edits: PhotoEditsRepository,
  photoId: string,
  sessionId: string,
  session: string,
): string {
  const chosen = db
    .query('SELECT doc FROM edit_conflicts WHERE photo_id = ? AND session_id = ?')
    .get(photoId, sessionId) as { doc: string } | null;
  if (chosen == null) throw new AppError('NOT_FOUND', `no parked edit ${sessionId} for photo ${photoId}`);

  const library = db.query('SELECT library_id FROM photos WHERE id = ?').get(photoId) as
    | { library_id: string }
    | null;
  if (library == null) throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);

  edits.save(photoId, parseDoc(chosen.doc), edits.get(photoId).rev, session);

  const parked = db
    .query('SELECT session_id FROM edit_conflicts WHERE photo_id = ?')
    .all(photoId) as { session_id: string }[];
  // One stamp for all of them: keeping this candidate is a single decision, and a
  // stamp apiece would say the reader resolved the divergence several times over.
  const at = stamp(db);
  db.transaction(() => {
    db.query('DELETE FROM edit_conflicts WHERE photo_id = ?').run(photoId);
    for (const row of parked) {
      tombstone(db, library.library_id, 'edit_conflict', `${photoId}/${row.session_id}`, at);
    }
  })();
  return library.library_id;
}

function peerNameOf(db: Database, libraryId: string, peer: string): string {
  const row = db
    .query('SELECT name FROM replication_peers WHERE library_id = ? AND peer_id = ?')
    .get(libraryId, peer) as { name: string } | null;
  return row?.name ?? peer;
}

// A candidate's own undo stack, which is what "how much work is in this one" means.
function countEdits(history: string | null): number {
  if (history == null) return 0;
  try {
    const parsed = EditHistorySchema.safeParse(JSON.parse(history));
    return parsed.success ? parsed.data.length : 0;
  } catch {
    return 0;
  }
}

function parseDoc(raw: string): EditDoc {
  const parsed = EditDocSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'a parked edit could not be read');
  return parsed.data;
}
