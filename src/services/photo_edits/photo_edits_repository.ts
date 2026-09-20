import type { Database } from '../../db/driver';
import { AppError } from '../../errors';
import { stamp } from '../replication/stamps';
import { MAX_CHAIN_HOPS, parseChain, type SessionHop } from './edit_sessions';
import {
  EditDocSchema,
  EditHistorySchema,
  applyEdits,
  diffEdits,
  neutralEdits,
  type EditDelta,
  type EditDoc,
  type EditState,
} from '../../schemas/photo_edits';

// How many steps one photo's undo stack keeps, oldest dropped first.
//
// ponytail: a cap rather than pruning, because the array shape makes a commit a
// read-modify-write of the whole blob - O(history) per slider release rather than
// O(1). At a thousand deltas that is tens of kilobytes and nothing; it stops being
// nothing somewhere in the tens of thousands, and this is what keeps it there.
// Rows per delta, keyed by an integer surrogate, is the upgrade if one is needed.
const MAX_EDIT_HISTORY = 1000;

interface Row {
  doc: string;
  cursor: number;
  rev: number;
  session_id: string | null;
  chain: string | null;
  stamp: string | null;
}

/**
 * One photo's develop settings and its undo stack.
 *
 * Two tables, written together. Nothing detects a desync between them - undo
 * assigns `deltas[cursor - 1].from` rather than checking the document currently
 * equals `to` - so every write here is one transaction, and **every writer of
 * `photo_edits.doc` goes through `save`**. A direct write to the document is the
 * one bug this schema cannot see.
 */
export class PhotoEditsRepository {
  constructor(private readonly db: Database) {}

  /** The photo's edits, or the neutral document at rev 0 where it has none. */
  get(photoId: string): EditState {
    const row = this.row(photoId);
    if (row == null) return { doc: neutralEdits(), rev: 0, canUndo: false, canRedo: false };
    const history = this.history(photoId);
    // Bounded by the history that is actually there, not just by the cursor. A
    // history that would not parse degrades to empty (see `history`), and a cursor
    // left pointing past it would otherwise offer an undo that steps into nothing.
    const cursor = Math.min(Math.max(row.cursor, 0), history.length);
    return {
      doc: this.parseDoc(row.doc),
      rev: row.rev,
      canUndo: cursor > 0,
      canRedo: cursor < history.length,
    };
  }

  /**
   * Commits a document, deriving the delta from what is already stored.
   *
   * A save that moves nothing writes nothing and leaves `rev` where it is, so a
   * retried request is a no-op rather than an undo step that undoes to the picture
   * it redoes to.
   */
  save(photoId: string, doc: EditDoc, rev: number, session?: string): EditState {
    return this.write(photoId, rev, (current, history, cursor) => {
      const delta = diffEdits(current, doc);
      if (delta == null) return null;
      // The redo tail goes first: a new edit after an undo is a new branch, and
      // the steps it replaces are no longer reachable.
      const kept = [...history.slice(0, cursor), delta];
      const capped = kept.slice(Math.max(0, kept.length - MAX_EDIT_HISTORY));
      return { doc, history: capped, cursor: capped.length };
    }, session);
  }

  undo(photoId: string, rev: number): EditState {
    return this.write(photoId, rev, (current, history, cursor) => {
      if (cursor <= 0) return null;
      const step = history[cursor - 1];
      if (step == null) return null;
      // The array is untouched. Truncating instead would be one line shorter and
      // would lose redo.
      return { doc: applyEdits(current, step.from), history, cursor: cursor - 1 };
    });
  }

  redo(photoId: string, rev: number): EditState {
    return this.write(photoId, rev, (current, history, cursor) => {
      const step = history[cursor];
      if (step == null) return null;
      return { doc: applyEdits(current, step.to), history, cursor: cursor + 1 };
    });
  }

  /**
   * One photo's document as it is stored, and which document that is; null where
   * it has none.
   *
   * Raw JSON rather than a parsed document: the caller is the rendition path, which parses
   * it with the same function the batch path uses on a column it read through a join. One
   * parse, one fallback, one place that decides what an unreadable document means.
   *
   * The stamp comes with it because a render has to record what it was built from,
   * and reading that separately afterwards would name a document this render may
   * not have used.
   */
  docFor(photoId: string): { doc: string; stamp: string | null } | null {
    const row = this.row(photoId);
    return row == null ? null : { doc: row.doc, stamp: row.stamp };
  }

  // The one place either table is written, so the pair cannot be updated apart
  // and the revision cannot be bumped without both moving.
  private write(
    photoId: string,
    rev: number,
    step: (
      doc: EditDoc,
      history: EditDelta[],
      cursor: number,
    ) => { doc: EditDoc; history: EditDelta[]; cursor: number } | null,
    session?: string,
  ): EditState {
    return this.db.transaction(() => {
      const row = this.row(photoId);
      const held = row?.rev ?? 0;
      if (held !== rev) {
        throw new AppError(
          'CONFLICT',
          `these edits have moved on: the photo is at revision ${held}, not ${rev}`,
        );
      }

      const current = row == null ? neutralEdits() : this.parseDoc(row.doc);
      const history = this.history(photoId);
      const cursor = Math.min(Math.max(row?.cursor ?? 0, 0), history.length);
      const next = step(current, history, cursor);
      if (next == null) {
        return { doc: current, rev: held, canUndo: cursor > 0, canRedo: cursor < history.length };
      }

      const at = new Date().toISOString();
      const mark = stamp(this.db);
      const lineage = this.lineage(row, session);
      this.db
        .query(
          `INSERT INTO photo_edits (photo_id, doc, cursor, rev, updated_at, stamp, session_id, chain)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(photo_id) DO UPDATE SET doc = excluded.doc, cursor = excluded.cursor,
             rev = excluded.rev, updated_at = excluded.updated_at, stamp = excluded.stamp,
             session_id = excluded.session_id, chain = excluded.chain`,
        )
        .run(
          photoId,
          JSON.stringify(next.doc),
          next.cursor,
          held + 1,
          at,
          mark,
          lineage.session,
          JSON.stringify(lineage.chain),
        );
      this.db
        .query(
          `INSERT INTO photo_edit_history (photo_id, deltas) VALUES (?, ?)
           ON CONFLICT(photo_id) DO UPDATE SET deltas = ?`,
        )
        .run(photoId, JSON.stringify(next.history), JSON.stringify(next.history));

      return {
        doc: next.doc,
        rev: held + 1,
        canUndo: next.cursor > 0,
        canRedo: next.cursor < next.history.length,
      };
    })();
  }

  /**
   * The session this write belongs to and the hops behind it (§5.3).
   *
   * A hop is appended when the session changes, so the chain records where this
   * one branched from - and it records the session's *last* stamp, which is what
   * makes a merge able to tell "built on that state" from "built on an older save
   * of it". Undo and redo carry no session of their own and continue the one that
   * is there, being steps inside the same open editor.
   */
  private lineage(row: Row | null, session: string | undefined): { session: string | null; chain: SessionHop[] } {
    const held = row?.session_id ?? null;
    const chain = parseChain(row?.chain);
    if (session == null || session === held) return { session: held, chain };
    if (held != null && row?.stamp != null) chain.push([held, row.stamp]);
    return { session, chain: chain.slice(Math.max(0, chain.length - MAX_CHAIN_HOPS)) };
  }

  private row(photoId: string): Row | null {
    return this.db
      .query('SELECT doc, cursor, rev, session_id, chain, stamp FROM photo_edits WHERE photo_id = ?')
      .get(photoId) as Row | null;
  }

  // A document the current schema cannot read falls back to neutral rather than
  // failing the request, the same way a bad settings row does: the editor opening
  // on an unedited picture beats it not opening at all. Unknown keys survive the
  // round trip, so a document from a newer build keeps the fields this build has
  // never heard of.
  private parseDoc(raw: string): EditDoc {
    try {
      const parsed = EditDocSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : neutralEdits();
    } catch {
      return neutralEdits();
    }
  }

  // Nothing renders a picture from the history, so a corrupt or out-of-range one
  // degrades to "no undo available" and leaves the document readable.
  private history(photoId: string): EditDelta[] {
    const row = this.db
      .query('SELECT deltas FROM photo_edit_history WHERE photo_id = ?')
      .get(photoId) as { deltas: string } | null;
    if (row == null) return [];
    try {
      const parsed = EditHistorySchema.safeParse(JSON.parse(row.deltas));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }
}
