// The loupe's tile path carries what the crop cannot measure about the photograph - its noise fit
// and its levels - and the two ends of each parameter are written in two languages: `tilePath`
// packs the numbers here and `noiseFitOf` / `levelsOf` unpack them in
// `src/api/image/image_api.ts`. Neither side reads the values, so a transposed pair or a renamed
// parameter produces a tile rather than an error - every crop denoised at some other frame's
// strength, or graded against its own diffuse white, with nothing to say so.
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

const LEVELS = { white: 8133, peak: 13783 };

describe('the tile path', () => {
  test('leaves out what there is none of to send', () => {
    expect(tilePath('a-photo-id', RECT)).toBe(
      '/image/a-photo-id/tile?left=100&top=200&width=256&height=256',
    );
    const neither = tilePath('a-photo-id', RECT, null, null);
    expect(neither).not.toContain('noise=');
    expect(neither).not.toContain('levels=');
  });

  test('sends the levels without a fit, and a fit without the levels', () => {
    expect(tilePath('a-photo-id', RECT, null, LEVELS)).toContain('&levels=8133,13783');
    expect(tilePath('a-photo-id', RECT, FIT, null)).not.toContain('levels=');
  });

  test('sends the tick\'s own scene peak, in nits', () => {
    expect(tilePath('a-photo-id', RECT, null, null, 4130.5)).toContain('&scenePeak=4130.5');
    expect(tilePath('a-photo-id', RECT, FIT, LEVELS)).not.toContain('scenePeak=');

    const server = readFileSync(SERVER, 'utf8');
    expect(server, 'the server no longer reads a `scenePeak` query parameter').toContain(
      "c.req.query('scenePeak')",
    );
  });

  test('packs the levels as the pair the server unpacks', () => {
    const query = tilePath('a-photo-id', RECT, FIT, LEVELS).split('&levels=')[1];
    expect(query).toBe('8133,13783');

    const server = readFileSync(SERVER, 'utf8');
    expect(server, 'the server no longer reads a `levels` query parameter').toContain(
      "c.req.query('levels')",
    );
    // White first, which is the half of the contract a pair of numbers cannot carry.
    expect(server).toContain('const [white, peak] = parts');
    expect(server).toContain('parts.length !== 2');
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
