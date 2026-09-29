import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PathSegment, route } from '../../../schemas/route';
import { stagePath, stagedSize, stagingDir } from '../blob_store';
import { addPhoto, forgetPeers, LIB, library, makePeer } from './blob_transfers_test_helpers';

afterEach(forgetPeers);

it('serves resumed original bytes over HTTP with their exact range headers', async () => {
  const peer = makePeer('range');
  addPhoto(peer, 'p1', 'p1.arw', '0123456789ABCDEF');
  const server = Bun.serve({ port: 0, fetch: peer.routes.fetch });
  try {
    const response = await fetch(`http://localhost:${server.port}${route('p1', PathSegment.original())}`, {
      headers: { Range: 'bytes=12-' },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 12-15/16');
    expect(response.headers.get('content-length')).toBe('4');
    expect(await response.text()).toBe('CDEF');
    await Bun.sleep(0);
    expect(peer.activity.current(LIB)).toEqual([]);

    for (const range of [undefined, 'bytes=12-', 'bytes=99-200']) {
      const head = await fetch(`http://localhost:${server.port}${route('p1', PathSegment.original())}`, {
        method: 'HEAD', headers: range == null ? {} : { Range: range },
      });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-range')).toBeNull();
      expect(head.headers.get('content-length')).toBe('16');
      expect(await head.text()).toBe('');
      expect(peer.activity.current(LIB)).toEqual([]);
    }
  } finally {
    server.stop(true);
  }
});

describe('push', () => {
  it('skips and flags an occupied target, and the location row is only written after the rename', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'one.arw', 'RAW-one');
    addPhoto(b, 'photo1', 'one.arw');
    // The user's own file, unscanned, differing only in case: still theirs (§7.7).
    writeFileSync(path.join(b.root, 'ONE.ARW'), 'users own');

    await a.transfers.pushDiff(LIB, b.id, { library: true });
    await a.transfers.drain();

    const item = a.transfers.list(LIB)[0]!;
    expect(item.state).toBe('failed');
    expect(item.error).toContain('occupied');
    expect(readFileSync(path.join(b.root, 'ONE.ARW'), 'utf8')).toBe('users own');
    const names = readdirSync(b.root);
    expect(names).toContain('ONE.ARW');
    expect(names).not.toContain('one.arw');
    expect(b.locations.heldBy(LIB, 'photo1', b.id)).toBe(false);
    expect(b.locations.flags(LIB)).toEqual([
      { library_id: LIB, photo_id: 'photo1', target_path: 'one.arw', reason: 'target occupied by ONE.ARW' },
    ]);
    // The staged copy is kept, so the retry after the user resolves the
    // collision resumes without re-sending a byte.
    expect(stagedSize(stagePath(library(b), 'photo1'))).toBe(7);
    expect(existsSync(stagingDir(library(b)))).toBe(true);

    rmSync(path.join(b.root, 'ONE.ARW'));
    a.sent.length = 0;
    expect(await a.transfers.pushDiff(LIB, b.id, { library: true })).toBe(1);
    await a.transfers.drain();
    expect(a.transfers.list(LIB)[0]!.state).toBe('done');
    expect(a.sent.filter((r) => r.method === 'PUT')).toEqual([]);
    expect(readFileSync(path.join(b.root, 'one.arw'), 'utf8')).toBe('RAW-one');
    expect(b.locations.heldBy(LIB, 'photo1', b.id)).toBe(true);
    expect(b.locations.flags(LIB)).toEqual([]);
    expect(existsSync(stagingDir(library(b)))).toBe(false);
  });
});
