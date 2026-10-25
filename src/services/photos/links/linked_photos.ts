import type { Database } from '../../../db/driver';
import { stamp } from '../../replication/stamps';
import { tombstone } from '../../replication/tombstones';
import { StackMembership } from '../../stacks/stack_membership';
import { StacksRepository } from '../../stacks/stacks_repository';
import { refreshStackOf } from '../paths/photo_stack_state';
import { IN_CHUNK, inChunks } from '../photo_batches';

/** What linked photographs hold as one: each replicated unit's stamp and its columns. */
const SHARED_UNITS = [
  { stamp: 'stamp_triage', columns: ['rating', 'triage', 'notes'] },
  { stamp: 'stamp_hidden', columns: ['is_hidden'] },
] as const;

interface Link {
  library_id: string;
  raw_id: string;
  camera_file_id: string;
}

interface Group {
  libraryId: string;
  /** Whether each member is a RAW. */
  members: Map<string, boolean>;
  holdsNewLink: boolean;
}

type Cell = string | number | null;

const AGREED = `EXISTS (
  SELECT 1 FROM photos raw, photos file
   WHERE raw.id = photo_links.raw_id AND file.id = photo_links.camera_file_id
     AND ${SHARED_UNITS.flatMap((unit) => unit.columns)
       .map((column) => `raw.${column} IS file.${column}`)
       .join(' AND ')}
     AND file.stack_id IS NULL
     AND NOT EXISTS (
       SELECT label_id FROM photo_labels WHERE photo_id = raw.id
       EXCEPT SELECT label_id FROM photo_labels WHERE photo_id = file.id)
     AND NOT EXISTS (
       SELECT label_id FROM photo_labels WHERE photo_id = file.id
       EXCEPT SELECT label_id FROM photo_labels WHERE photo_id = raw.id))`;

/**
 * Gives every photograph linked to a new link, or to one of `ids`, one set of marks and labels:
 * per unit the member with the latest stamp, and a label held by any member unless its removal
 * from another is later. A camera file in a stack when its link forms hands its place to its RAW.
 */
export function reconcileLinks(db: Database, ids: readonly string[] = []): void {
  // A rename unlinks and relinks every pair it moves, one half at a time.
  db.query(`UPDATE photo_links SET pending = 0 WHERE pending = 1 AND ${AGREED}`).run();
  const groups = groupsOf(db, ids, true);
  share(db, groups);
  for (const group of groups) if (group.holdsNewLink) swapIntoStacks(db, group);
  db.query('UPDATE photo_links SET pending = 0 WHERE pending = 1').run();
}

/**
 * Shares marks and labels across the photographs linked to `ids`, leaving stacks and new links to
 * `reconcileLinks`: for a replication page, whose stacks may still be arriving.
 */
export function shareAcrossLinks(db: Database, ids: readonly string[]): void {
  share(db, groupsOf(db, ids, false));
}

/** `ids` and every photograph linked to one, which share labels and marks (`reconcileLinks`). */
export function withEveryLinkedPhoto(db: Database, ids: readonly string[]): string[] {
  return [
    ...new Set([...ids, ...groupsOf(db, ids, false).flatMap((group) => [...group.members.keys()])]),
  ];
}

function share(db: Database, groups: readonly Group[]): void {
  if (groups.length === 0) return;
  let at: string | null = null;
  // A stamp minted here rather than the source's: a copy under the source's stamp is one a peer
  // already covering that stamp is never sent, so a peer whose link existed only for a while
  // would end up holding a value nobody else does.
  const now = (): string => (at ??= stamp(db));
  const restacked: string[] = [];
  for (const group of groups) {
    restacked.push(...shareMarks(db, group, now));
    shareLabels(db, group, now);
  }
  const stacks = new StackMembership(db);
  for (const id of restacked) refreshStackOf(db, stacks, id);
}

function groupsOf(db: Database, ids: readonly string[], withNewLinks: boolean): Group[] {
  const seeds = withNewLinks
    ? (
        db.query('SELECT raw_id FROM photo_links WHERE pending = 1').all() as {
          raw_id: string;
        }[]
      ).map((row) => row.raw_id)
    : [];
  const placed = new Set<string>();
  const groups: Group[] = [];
  for (const [index, seed] of [...seeds, ...ids].entries()) {
    if (placed.has(seed)) continue;
    const group: Group = { libraryId: '', members: new Map(), holdsNewLink: index < seeds.length };
    let frontier = [seed];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const link of linksOf(db, frontier)) {
        group.libraryId = link.library_id;
        for (const [id, isRaw] of [
          [link.raw_id, true],
          [link.camera_file_id, false],
        ] as const) {
          if (group.members.has(id)) continue;
          group.members.set(id, isRaw);
          next.push(id);
        }
      }
      frontier = next;
    }
    for (const id of group.members.keys()) placed.add(id);
    placed.add(seed);
    if (group.members.size > 1) groups.push(group);
  }
  return groups;
}

function linksOf(db: Database, ids: readonly string[]): Link[] {
  const links: Link[] = [];
  for (const batch of inChunks(ids, IN_CHUNK / 2)) {
    const placeholders = batch.map(() => '?').join(', ');
    links.push(
      ...(db
        .query(
          `SELECT library_id, raw_id, camera_file_id FROM photo_links
            WHERE raw_id IN (${placeholders}) OR camera_file_id IN (${placeholders})`,
        )
        .all(...batch, ...batch) as Link[]),
    );
  }
  return links;
}

function shareMarks(db: Database, group: Group, now: () => string): string[] {
  const changed: string[] = [];
  for (const unit of SHARED_UNITS) {
    const read = db.query(
      `SELECT ${[...unit.columns, unit.stamp].join(', ')} FROM photos WHERE id = ?`,
    );
    const rows = [...group.members].flatMap(([id, isRaw]) => {
      const row = read.get(id) as Record<string, Cell> | null;
      return row == null ? [] : [{ id, isRaw, row }];
    });
    // Ties go to a RAW, then to the larger id, so every peer settles one the same way.
    const rank = (member: (typeof rows)[number]): string =>
      `${String(member.row[unit.stamp] ?? '')}\u0000${member.isRaw ? 1 : 0}\u0000${member.id}`;
    const winner = rows.reduce<(typeof rows)[number] | null>(
      (best, member) => (best == null || rank(member) > rank(best) ? member : best),
      null,
    );
    if (winner == null) continue;
    const write = db.query(
      `UPDATE photos SET ${unit.columns.map((column) => `${column} = ?`).join(', ')}, ${unit.stamp} = ?
        WHERE id = ?`,
    );
    for (const member of rows) {
      if (unit.columns.every((column) => member.row[column] === winner.row[column])) continue;
      write.run(...unit.columns.map((column) => winner.row[column] ?? null), now(), member.id);
      changed.push(member.id);
    }
  }
  return changed;
}

function shareLabels(db: Database, group: Group, now: () => string): void {
  const held = new Map<string, Map<string, string>>();
  for (const id of group.members.keys()) {
    const rows = db
      .query('SELECT label_id, stamp FROM photo_labels WHERE photo_id = ?')
      .all(id) as { label_id: string; stamp: string | null }[];
    for (const row of rows) {
      const holders = held.get(row.label_id) ?? new Map<string, string>();
      holders.set(id, row.stamp ?? '');
      held.set(row.label_id, holders);
    }
  }
  const removedAt = db.query(
    `SELECT stamp FROM replication_log
      WHERE library_id = ? AND entity = 'photo_label' AND row_id = ? AND deleted = 1`,
  );
  for (const [labelId, holders] of held) {
    const lacking = [...group.members.keys()].filter((id) => !holders.has(id));
    if (lacking.length === 0) continue;
    const added = latest([...holders.values()]);
    const removed = latest(
      lacking.map(
        (id) =>
          (removedAt.get(group.libraryId, `${labelId}/${id}`) as { stamp: string } | null)?.stamp ??
          '',
      ),
    );
    if (removed > added) {
      for (const id of holders.keys()) {
        db.query('DELETE FROM photo_labels WHERE label_id = ? AND photo_id = ?').run(labelId, id);
        tombstone(db, group.libraryId, 'photo_label', `${labelId}/${id}`, now());
      }
      continue;
    }
    const insert = db.query(
      'INSERT OR IGNORE INTO photo_labels (library_id, label_id, photo_id, stamp) VALUES (?, ?, ?, ?)',
    );
    for (const id of lacking) insert.run(group.libraryId, labelId, id, now());
  }
}

/**
 * Takes each camera file out of its stack, putting the group's RAW in its place where the RAW is
 * in no stack and was never taken out of one, or only in a detected stack while this one is a
 * person's.
 */
function swapIntoStacks(db: Database, group: Group): void {
  const stackOf = db.query(
    'SELECT s.id, s.origin FROM photos p JOIN stacks s ON s.id = p.stack_id WHERE p.id = ?',
  );
  const ids = [...group.members.keys()].sort();
  const raw = ids.find((id) => group.members.get(id) === true);
  if (raw == null) return;
  const unstacked =
    db.query("SELECT 1 FROM photos WHERE id = ? AND stack_state = 'unstacked'").get(raw) != null;
  const stacks = new StacksRepository(db);
  for (const id of ids) {
    if (group.members.get(id) === true) continue;
    const held = stackOf.get(id) as { id: string; origin: string } | null;
    if (held == null) continue;
    const rawIn = stackOf.get(raw) as { id: string; origin: string } | null;
    const takesPlace =
      rawIn == null ? !unstacked : rawIn.origin === 'auto' && held.origin === 'manual';
    if (takesPlace) {
      stacks.addPhotos(held.id, [raw]);
      if (rawIn != null) stacks.dissolveIfSpent(rawIn.id, false);
    }
    stacks.removePhotos(held.id, [id], false);
    stacks.dissolveIfSpent(held.id, false);
  }
}

const latest = (stamps: string[]): string => stamps.reduce((a, b) => (a > b ? a : b), '');
