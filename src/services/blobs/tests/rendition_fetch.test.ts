import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PathSegment, route } from '../../../schemas/route';
import { getRenditionPath } from '../../../utils/paths';
import { renditionVariant, storedAsHdr } from '../../processing/renditions/renditions';
import type { BasicPhoto } from '../../photos/paths/photo_paths_repository';
import { renditionCurrent } from '../rendition_fetch_service';
import {
  addPhoto,
  BUILT_AT,
  BUILT_FROM,
  buildTile,
  EDITED_AFTER,
  EDITED_BEFORE,
  forgetPeers,
  holderAndReplica,
  library,
  makePeer,
  net,
  pair,
  type Peer,
  tilePath,
} from './rendition_fetch_test_helpers';

afterEach(forgetPeers);

// A stamp rather than a time, because that is what staleness is decided on: the
// edit and the build happen on different machines, so a wall clock decides it
// against somebody else's clock.
function edited(peer: Peer, photoId: string, at: string): void {
  peer.db
    .query(
      "INSERT INTO photo_edits (photo_id, doc, cursor, rev, updated_at, stamp) VALUES (?, '{}', 0, 1, ?, ?)",
    )
    .run(photoId, BUILT_AT, at);
}

describe('renditionCurrent', () => {
  it('is current until the develop settings move past what it was built from', () => {
    expect(renditionCurrent(null, null)).toBe(true);
    expect(renditionCurrent(BUILT_FROM, null)).toBe(true);
    expect(renditionCurrent(BUILT_FROM, BUILT_FROM)).toBe(true);
    expect(renditionCurrent(BUILT_FROM, EDITED_BEFORE)).toBe(true);
    expect(renditionCurrent(BUILT_FROM, EDITED_AFTER)).toBe(false);
    expect(renditionCurrent(null, EDITED_AFTER)).toBe(false);
  });

  /**
   * The reason this is stamps and not times.
   *
   * A build happens on whichever peer holds the original and an edit on whichever
   * peer made it, and a catalogue-only peer never builds at all - so the two values
   * come from different machines' clocks as a matter of course. A clock a minute
   * slow hides the edit for good: nothing re-queues it, the holder serves the old
   * picture to every peer as current, and the reader watches their own edit fail to
   * appear. A minute is well inside what the HLC deliberately absorbs.
   */
  it('is decided on values that do not come from a wall clock', () => {
    const editedOnASlowPeer = EDITED_AFTER;
    const builtHereALittleLater = BUILT_FROM;

    expect(editedOnASlowPeer > builtHereALittleLater).toBe(true);
    expect(renditionCurrent(builtHereALittleLater, editedOnASlowPeer)).toBe(false);
  });
});

describe('fetching a rendition through a peer', () => {
  it('reports the missing original for a standalone library', async () => {
    const local = makePeer('local');
    local.db.query('DELETE FROM replication_libraries WHERE library_id = ?').run(local.lib);
    addPhoto(local, 'photo1', 'Day1/one.arw');
    const request = spyOn(local.transport, 'request');
    const canReach = spyOn(local.transport, 'canReach');
    const message = `This photo's original is missing. Restore it to "${path.join(local.root, 'Day1/one.arw')}" and scan the library again.`;

    for (const rendition of ['full', 'max'] as const) {
      await expect(local.fetch.ensureCurrent('photo1', rendition)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message,
      });
    }

    expect(request).not.toHaveBeenCalled();
    expect(canReach).not.toHaveBeenCalled();
  });

  it('keeps a standalone cached rendition and refuses to rebuild without its original', async () => {
    const local = makePeer('local');
    local.db.query('DELETE FROM replication_libraries WHERE library_id = ?').run(local.lib);
    addPhoto(local, 'photo1', 'Day1/one.arw');
    const request = spyOn(local.transport, 'request');
    const canReach = spyOn(local.transport, 'canReach');
    const hdr = storedAsHdr('max', library(local).rendition_hdr);
    const target = getRenditionPath(library(local), 'photo1', 'max', hdr);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, 'MAX-BYTES');
    local.photoProcessing.markCopyBuilt(
      'photo1',
      BUILT_AT,
      BUILT_FROM,
      renditionVariant('max', hdr),
    );
    edited(local, 'photo1', EDITED_AFTER);

    await local.fetch.ensureCurrent('photo1', 'max');
    expect(readFileSync(target, 'utf8')).toBe('MAX-BYTES');
    await expect(local.fetch.ensureCurrent('photo1', 'max', true)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: `This photo's original is missing. Restore it to "${path.join(local.root, 'Day1/one.arw')}" and scan the library again.`,
    });

    expect(readFileSync(target, 'utf8')).toBe('MAX-BYTES');
    expect(request).not.toHaveBeenCalled();
    expect(canReach).not.toHaveBeenCalled();
  });

  it('caches a holder-built tile where the local pipeline would have written it', async () => {
    const { a, b } = holderAndReplica();
    buildTile(a, 'photo1', 'TILE-BYTES', BUILT_FROM);

    await b.fetch.ensureCurrent('photo1', 'grid');

    expect(readFileSync(tilePath(b, 'photo1'), 'utf8')).toBe('TILE-BYTES');
    // Recorded against the settings the *sender* rendered, so an edit replicated
    // later still reads as newer than the copy it invalidates.
    expect(b.photoProcessing.renditionStamps('photo1', 'grid')?.built_from).toBe(BUILT_FROM);

    // A second ask is answered from the cache, with the holder gone.
    net.delete(a.id);
    await b.fetch.ensureCurrent('photo1', 'grid');
    expect(readFileSync(tilePath(b, 'photo1'), 'utf8')).toBe('TILE-BYTES');
  });

  it('says it is fetching a copy the holder has, and rendering one it has to build', async () => {
    const { a, b } = holderAndReplica();
    await b.fetch.ensureCurrent('photo1', 'full');
    await b.fetch.ensureCurrent('photo1', 'full', true);
    a.camera.set('photo1', 'JPEG-one');
    await b.fetch.ensureCurrent('photo1', 'embedded');

    expect(b.phases).toEqual([
      'full of photo1: rendering',
      'full of photo1: settled',
      'full of photo1: rendering',
      'full of photo1: settled',
      'embedded of photo1: fetching',
      'embedded of photo1: settled',
    ]);
  });

  it('says it is fetching when the holder already built the rendition', async () => {
    const { a, b } = holderAndReplica();
    const hdr = storedAsHdr('full', library(b).rendition_hdr);
    const built = getRenditionPath(library(a), 'photo1', 'full', hdr);
    mkdirSync(path.dirname(built), { recursive: true });
    writeFileSync(built, 'FULL-BYTES');
    a.photoProcessing.markCopyBuilt('photo1', BUILT_AT, BUILT_FROM, renditionVariant('full', hdr));

    await b.fetch.ensureCurrent('photo1', 'full');

    expect(b.phases).toEqual(['full of photo1: fetching', 'full of photo1: settled']);
  });

  it('keeps a grid scroll quiet', async () => {
    const { a, b } = holderAndReplica();
    buildTile(a, 'photo1', 'TILE-BYTES', BUILT_FROM);
    await b.fetch.ensureCurrent('photo1', 'grid');
    expect(b.phases).toEqual([]);
  });

  // The one thing a caller needs that the bytes cannot tell it: which develop
  // settings they are of, so it can hold them against an edit this holder has not
  // been told about yet.
  it('reports which settings it rendered', async () => {
    const { a } = holderAndReplica();
    buildTile(a, 'photo1', 'TILE-BYTES', BUILT_FROM);

    const res = await a.routes.request(route('photo1', PathSegment.rendition(), 'grid'));

    expect(res.headers.get('x-rendition-built-from')).toBe(BUILT_FROM);
  });

  it('leaves a photo alone when the original is here to build from', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'Day1/one.arw', 'RAW-one');
    addPhoto(b, 'photo1', 'Day1/one.arw', 'RAW-one');
    pair(a, b, 'photo1');
    buildTile(a, 'photo1', 'TILE-BYTES', BUILT_FROM);

    await b.fetch.ensureCurrent('photo1', 'grid');

    expect(existsSync(tilePath(b, 'photo1'))).toBe(false);
  });

  /**
   * A reported build stamp is bounded, not merely well formed.
   *
   * It lands in the column that decides staleness from then on, so a peer answering
   * with a stamp dated centuries ahead - which is a valid stamp - would leave this
   * device holding a rendition no edit could ever sort above, and re-advertising
   * that stamp to the next peer. Contagious, permanent, and silent.
   */
  it('never records a build stamp the clock will not take', async () => {
    const { a, b } = holderAndReplica();
    const centuriesAhead = `ffffffffffff0000${'peerpeerpeerpeer'}`;
    buildTile(a, 'photo1', 'TILE-BYTES', centuriesAhead);
    edited(b, 'photo1', EDITED_AFTER);

    await b.fetch.ensureCurrent('photo1', 'grid');
    expect(b.photoProcessing.renditionStamps('photo1', 'grid')?.built_from).toBeNull();
  });

  // Every edit made here while the two devices cannot sync is one the holder never hears of.
  it('shows the holder’s copy from before an edit made here rather than a hole, still owed', async () => {
    const { a, b } = holderAndReplica();
    buildTile(a, 'photo1', 'TILE-BYTES', BUILT_FROM);
    edited(b, 'photo1', EDITED_AFTER);

    await b.fetch.ensureCurrent('photo1', 'grid');

    expect(readFileSync(tilePath(b, 'photo1'), 'utf8')).toBe('TILE-BYTES');
    const stamps = b.photoProcessing.renditionStamps('photo1', 'grid');
    expect(renditionCurrent(stamps?.built_from ?? null, stamps?.edited_from ?? null)).toBe(false);
  });

  it('refuses a copy the holder has itself edited past', async () => {
    const { a, b } = holderAndReplica();
    buildTile(a, 'photo1', 'TILE-BYTES', EDITED_BEFORE);
    edited(a, 'photo1', EDITED_AFTER);

    await expect(b.fetch.ensureCurrent('photo1', 'grid')).rejects.toThrow(
      /no peer holds a current/,
    );
    expect(existsSync(tilePath(b, 'photo1'))).toBe(false);
  });

  it('has the holder render a copy it lacks, at the range this device shows', async () => {
    const { b } = holderAndReplica();
    b.db.query('UPDATE libraries SET rendition_hdr = 1 WHERE id = ?').run(b.lib);

    await b.fetch.ensureCurrent('photo1', 'max');

    expect(readFileSync(getRenditionPath(library(b), 'photo1', 'max', true), 'utf8')).toBe(
      'max-hdr of photo1',
    );
  });

  it('has the holder lift the camera JPEG out of its original', async () => {
    const { a, b } = holderAndReplica();
    a.camera.set('photo1', 'CAMERA-JPEG');

    await b.fetch.ensureCurrent('photo1', 'embedded');

    expect(readFileSync(getRenditionPath(library(b), 'photo1', 'embedded', false), 'utf8')).toBe(
      'CAMERA-JPEG',
    );
  });

  describe('through a device that holds no original either', () => {
    // A holds the original, B syncs with A, and C syncs with B alone and has never heard of A.
    function chain(): { a: Peer; b: Peer; c: Peer } {
      const { a, b } = holderAndReplica();
      const c = makePeer('c');
      addPhoto(c, 'photo1', 'Day1/one.arw');
      pair(b, c, 'photo1');
      return { a, b, c };
    }

    it('passes the request on to the holder, and keeps the copy on the way back', async () => {
      const { b, c } = chain();
      c.db.query('UPDATE libraries SET rendition_hdr = 1 WHERE id = ?').run(c.lib);

      await c.fetch.ensureCurrent('photo1', 'max');

      expect(readFileSync(getRenditionPath(library(c), 'photo1', 'max', true), 'utf8')).toBe(
        'max-hdr of photo1',
      );
      expect(readFileSync(getRenditionPath(library(b), 'photo1', 'max', true), 'utf8')).toBe(
        'max-hdr of photo1',
      );
    });

    it('passes a forced render on, past the copy it holds itself', async () => {
      const { b, c } = chain();
      await c.fetch.ensureCurrent('photo1', 'max');

      await c.fetch.ensureCurrent('photo1', 'max', true);

      expect(readFileSync(getRenditionPath(library(c), 'photo1', 'max', true), 'utf8')).toBe(
        'max-hdr of photo1, forced',
      );
      expect(readFileSync(getRenditionPath(library(b), 'photo1', 'max', true), 'utf8')).toBe(
        'max-hdr of photo1, forced',
      );
    });

    it("passes on the camera's JPEG", async () => {
      const { a, c } = chain();
      a.camera.set('photo1', 'CAMERA-JPEG');

      await c.fetch.ensureCurrent('photo1', 'embedded');

      expect(readFileSync(getRenditionPath(library(c), 'photo1', 'embedded', false), 'utf8')).toBe(
        'CAMERA-JPEG',
      );
    });

    it('passes on a tile the holder built', async () => {
      const { a, c } = chain();
      buildTile(a, 'photo1', 'TILE-BYTES', BUILT_FROM);

      await c.fetch.ensureCurrent('photo1', 'grid');

      expect(readFileSync(tilePath(c, 'photo1'), 'utf8')).toBe('TILE-BYTES');
    });

    // Each can reach the other and neither has the original: every request that goes round comes
    // back to a device already on its path, which refuses to ask again rather than waiting on itself.
    it('gives up rather than going round two devices that each ask the other', async () => {
      const b = makePeer('b');
      const c = makePeer('c');
      addPhoto(b, 'photo1', 'Day1/one.arw');
      addPhoto(c, 'photo1', 'Day1/one.arw');
      pair(b, c, 'photo1');

      await expect(c.fetch.ensureCurrent('photo1', 'full')).rejects.toThrow(
        /no peer holds a current/,
      );
    });
  });

  it('takes pictures from a peer on a library that keeps no originals', async () => {
    const { b } = holderAndReplica();
    b.db
      .query('UPDATE replication_libraries SET sync_originals = 0 WHERE library_id = ?')
      .run(b.lib);

    await b.fetch.ensureCurrent('photo1', 'full');

    expect(readFileSync(getRenditionPath(library(b), 'photo1', 'full', true), 'utf8')).toBe(
      'full-hdr of photo1',
    );
  });

  it('takes a photo from a peer on a library that keeps no originals, until its original is fetched here', () => {
    const { b } = holderAndReplica();
    const photo = (): BasicPhoto => {
      const row = b.photoPaths.getBasicById('photo1');
      if (row == null) throw new Error('photo not found');
      return row;
    };
    expect(b.fetch.takesFromPeer(library(b), photo())).toBe(false);

    b.db
      .query('UPDATE replication_libraries SET sync_originals = 0 WHERE library_id = ?')
      .run(b.lib);
    expect(b.fetch.takesFromPeer(library(b), photo())).toBe(true);

    mkdirSync(path.join(b.root, 'Day1'), { recursive: true });
    writeFileSync(path.join(b.root, 'Day1/one.arw'), 'RAW-one');
    expect(b.fetch.takesFromPeer(library(b), photo())).toBe(false);
  });

  it('takes a photo from a peer on a read-only library whatever it keeps, until its original is here', () => {
    const { b } = holderAndReplica();
    const photo = b.photoPaths.getBasicById('photo1')!;
    const readOnly = { ...library(b), read_only: true };
    expect(b.fetch.takesFromPeer(readOnly, photo)).toBe(true);

    mkdirSync(path.join(b.root, 'Day1'), { recursive: true });
    writeFileSync(path.join(b.root, 'Day1/one.arw'), 'RAW-one');
    expect(b.fetch.takesFromPeer(readOnly, photo)).toBe(false);
  });

  it('has the holder render again when forced, and tells clients the copy they hold has changed', async () => {
    const { b } = holderAndReplica();
    await b.fetch.ensureCurrent('photo1', 'full');
    expect(b.announced).toEqual([]);

    await b.fetch.ensureCurrent('photo1', 'full', true);

    expect(readFileSync(getRenditionPath(library(b), 'photo1', 'full', true), 'utf8')).toBe(
      'full-hdr of photo1, forced',
    );
    expect(b.announced).toEqual(['renditions of photo1']);
  });

  it('says a forced render did not happen when no peer can answer, keeping the copy it had', async () => {
    const { a, b } = holderAndReplica();
    await b.fetch.ensureCurrent('photo1', 'full');
    net.delete(a.id);

    await expect(b.fetch.ensureCurrent('photo1', 'full', true)).rejects.toThrow(
      /no peer holds a current/,
    );
    expect(readFileSync(getRenditionPath(library(b), 'photo1', 'full', true), 'utf8')).toBe(
      'full-hdr of photo1',
    );
  });

  it('keeps a stale cached copy rather than a hole when no peer can answer', async () => {
    const { a, b } = holderAndReplica();
    buildTile(a, 'photo1', 'TILE-BYTES', BUILT_FROM);
    await b.fetch.ensureCurrent('photo1', 'grid');

    // An edit lands here that the holder has not replicated, so nothing it holds
    // is current any more.
    edited(b, 'photo1', EDITED_AFTER);
    await b.fetch.ensureCurrent('photo1', 'grid');

    expect(readFileSync(tilePath(b, 'photo1'), 'utf8')).toBe('TILE-BYTES');
  });
});
