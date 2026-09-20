// A panorama replicates as the photograph it is: the recipe rides `photo.placement`, which for a
// file photograph carries the path and for a composite carries what it is composed from - the
// same fact, "where this row's pixels come from", one level up (docs/replication.md §3).
//
// What these pin is that a composite crosses to a peer whole, and that the frames it names are
// carried by their own rows rather than by it.
import { describe, expect, it } from 'bun:test';
import { applyChanges } from '../apply';
import { LIB, makePeer, type Peer } from './peers';
import { stamp } from '../stamps';

const RECIPE = JSON.stringify({
  kind: 'panorama',
  version: 1,
  sources: [
    { photoId: 'photo001', size: [6000, 4000], rotation: [1, 0, 0, 0], focal: 5200, lens: { crop: 1 }, gain: 1 },
    { photoId: 'photo002', size: [6000, 4000], rotation: [1, 0, 0, 0], focal: 5200, lens: { crop: 1 }, gain: 1 },
  ],
  projection: 'cylindrical',
  canvas: [9000, 4200],
  centre: [4500, 2100],
  radiansPerPixel: 0.0002,
  crop: [0, 0, 1, 1],
  reference: 0,
});

function composite(peer: Peer, id: string): void {
  const at = stamp(peer.db);
  peer.db
    .query(
      `INSERT INTO photos (id, library_id, recipe, width, height, date_added, stamp_imported, stamp_placement)
         VALUES (?, ?, ?, 9000, 4200, '2026-01-01T00:00:00.000Z', ?, ?)`,
    )
    .run(id, LIB, RECIPE, at, at);
}

function logged(peer: Peer, rowId: string): string[] {
  const rows = peer.db
    .query('SELECT entity FROM replication_log WHERE library_id = ? AND row_id = ? AND deleted = 0 ORDER BY entity')
    .all(LIB, rowId) as { entity: string }[];
  return rows.map((row) => row.entity);
}

describe('a panorama', () => {
  it('is logged as a photograph, its recipe riding its placement', () => {
    const peer = makePeer('one');
    composite(peer, 'pano0001');

    expect(logged(peer, 'pano0001')).toContain('photo.placement');
  });

  it('applies on a peer that never had it, and indexes the frames it names', () => {
    const peer = makePeer('two');
    const arriving = stamp(peer.db);

    applyChanges(peer.db, LIB, [
      {
        kind: 'photo' as const,
        rowId: 'pano0001',
        deleted: false as const,
        sidecar: null,
        row: {
          id: 'pano0001',
          library_id: LIB,
          recipe: RECIPE,
          width: 9000,
          height: 4200,
          date_added: '2026-01-01T00:00:00.000Z',
        },
        stamps: { 'photo.placement': arriving },
      },
    ]);

    const row = peer.db.query('SELECT recipe, is_missing FROM photos WHERE id = ?').get('pano0001') as {
      recipe: string;
      is_missing: number;
    };
    expect(JSON.parse(row.recipe).kind).toBe('panorama');
    // A composite has no original to arrive, so nothing would ever clear the flag an ordinary
    // photograph lands with: marked missing here, it never renders on this peer.
    expect(row.is_missing).toBe(0);
    // The index is the receiving peer's own, rebuilt by the trigger off the recipe that arrived -
    // so a composite is openable on a peer that has never seen the merge.
    const frames = peer.db
      .query('SELECT photo_id FROM photo_sources WHERE composed_id = ? ORDER BY at')
      .all('pano0001') as { photo_id: string }[];
    expect(frames.map((frame) => frame.photo_id)).toEqual(['photo001', 'photo002']);
  });

  // A verdict is not a re-composition: a peer that only rated the panorama says nothing about the
  // recipe, and what it must not do is clear it.
  it('survives a change to the photograph that never mentions the recipe', () => {
    const peer = makePeer('three');
    composite(peer, 'pano0001');
    peer.advance();

    applyChanges(peer.db, LIB, [
      {
        kind: 'photo' as const,
        rowId: 'pano0001',
        deleted: false as const,
        sidecar: null,
        row: {
          id: 'pano0001',
          library_id: LIB,
          recipe: RECIPE,
          width: 9000,
          height: 4200,
          date_added: '2026-01-01T00:00:00.000Z',
          rating: 4,
        },
        stamps: { 'photo.triage': stamp(peer.db) },
      },
    ]);

    const row = peer.db.query('SELECT rating, recipe FROM photos WHERE id = ?').get('pano0001') as {
      rating: number;
      recipe: string;
    };
    expect(row.rating).toBe(4);
    expect(JSON.parse(row.recipe).kind).toBe('panorama');
  });
});
