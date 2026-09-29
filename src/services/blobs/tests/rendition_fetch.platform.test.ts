import { afterEach, describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BUILT_FROM, buildTile, forgetPeers, holderAndReplica, tilePath } from './rendition_fetch_test_helpers';

afterEach(forgetPeers);

describe('fetching a rendition through a peer', () => {
  describe('through a device that holds no original either', () => {
    it('lands two requests passed on at once for the same copy, whole', async () => {
      const { a, b } = holderAndReplica();
      buildTile(a, 'photo1', 'TILE-BYTES', BUILT_FROM);

      await Promise.all([b.fetch.relay('photo1', 'grid', false, []), b.fetch.relay('photo1', 'grid', false, [])]);

      expect(readFileSync(tilePath(b, 'photo1'), 'utf8')).toBe('TILE-BYTES');
      expect(readdirSync(path.dirname(tilePath(b, 'photo1')))).toEqual(['photo1.avif']);
    });
  });
});
