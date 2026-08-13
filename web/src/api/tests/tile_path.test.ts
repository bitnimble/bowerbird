// The loupe's tile path carries the frame's noise fit, and the two ends of that parameter are
// written in two languages: `tilePath` packs seven numbers here and `noiseFitOf` unpacks them in
// `src/api/image/image_api.ts`. Neither side reads the values, so a transposed pair or a renamed
// parameter produces a tile rather than an error - every crop denoised at some other frame's
// strength, or at its own, with nothing to say so.
//
// Importing the server's parser would pull Bun and node types into the browser program, so the
// server's own source is read and pinned, as `prepared_path.test.ts` pins the desktop shell's.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tilePath } from '../client';

const SERVER = join(import.meta.dir, '..', '..', '..', '..', 'src', 'api', 'image', 'image_api.ts');

const RECT = { left: 100, top: 200, width: 256, height: 256 };
const FIT = {
  alpha: 0.0001502,
  sigmaSq: 0.0000011,
  unifiedSigma: 1.1928239,
  darkRef: [0.1, -0.02, 0.33, 0.4] as [number, number, number, number],
};

describe('the tile path', () => {
  test('leaves the noise out where there is none to send', () => {
    expect(tilePath('a-photo-id', RECT)).toBe(
      '/image/a-photo-id/tile?left=100&top=200&width=256&height=256',
    );
    expect(tilePath('a-photo-id', RECT, null)).not.toContain('noise=');
  });

  test('packs the fit as the seven numbers the server unpacks', () => {
    const query = tilePath('a-photo-id', RECT, FIT).split('&noise=')[1];
    expect(query).toBe('0.0001502,0.0000011,1.1928239,0.1,-0.02,0.33,0.4');

    const server = readFileSync(SERVER, 'utf8');
    expect(server, 'the server no longer reads a `noise` query parameter').toContain(
      "c.req.query('noise')",
    );
    // The order it destructures them in, which is the half of the contract a shape cannot carry.
    expect(server).toContain('const [alpha, sigmaSq, unifiedSigma, ...darkRef] = parts');
    expect(server).toContain('parts.length !== 7');
  });
});
